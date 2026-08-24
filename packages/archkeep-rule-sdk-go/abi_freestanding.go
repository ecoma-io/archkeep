//go:build wasm_unknown

// The wasm-only half of the wire: three of the four exports the ABI names —
// the fourth, `memory`, is exported by TinyGo's own linkage — and the facts
// about this target that make them work.
//
// The build tag is TinyGo's own for the freestanding target
// (-target=wasm-unknown sets `wasm_unknown`; see targets/wasm-unknown.json in a
// TinyGo installation), and it is the tag rather than `wasm` deliberately:
// standard Go's GOARCH=wasm cannot produce this artifact at all — both of its
// wasm targets import a host, measured in ./README.md — and TinyGo's own
// wasm-unknown target reports GOARCH=arm, so a `wasm` tag would match neither
// the toolchain that can build this nor the one that cannot.
//
// # The file NAME is a build constraint too, and that is why it is this one
//
// Measured, after this file spent one build called `abi_wasm.go`: Go reads a
// `_GOARCH` suffix in a file name as an implicit constraint, `wasm` is a valid
// GOARCH, and the wasm-unknown target reports GOARCH=arm — so the file was
// excluded from the build that needed it most. Nothing said so. The artifact
// compiled, linked, and shipped every export except the three below, which the
// host refuses by name but only once a consumer has declared it. Any name whose
// last underscore-separated word is a GOOS or a GOARCH does this; this one's is
// "freestanding", which is neither.
//
// # Everything allocated here is PINNED, and that is the contract
//
// The host builds a fresh WebAssembly.Instance for every call and discards it
// when the call returns — "one instance per call, never reused", so that no
// call's leftover heap can reach the next call's judgment
// (../archkeep/src/custom-rules/host.mjs). A rule therefore has no lifetime
// beyond the call it is in: memory freed after the return would be freed into
// an instance nobody will ever look at again, and memory freed BEFORE the
// return would be the verdict bytes the host has not read yet.
//
// So [alloc] and [pack] hand their buffers to the host as bare integers and
// keep a reference in `pinned` so nothing can collect them. Under the target's
// own -gc=leaking that reference changes nothing, because nothing is ever
// collected; under any collecting GC it is what stops the evidence bundle from
// being reused as scratch while the host is still writing into it. It is not a
// leak in the sense that matters — the instance's entire linear memory is
// released with the instance.
//
// # Why //export and not //go:wasmexport
//
// Measured against tinygo 0.41.0, and the reason is the whole shape of this
// file. TinyGo wraps every //go:wasmexport function in a call to
// runtime.wasmExportCheckRun, which traps with "//go:wasmexport function called
// before runtime initialization" unless _initialize has been called first. The
// contract names four exports and _initialize is not one of them, so the host
// never calls it, and every //go:wasmexport artifact answers the very first
// archkeep_describe with RuntimeError: unreachable.
//
// //export has no such wrapper: the exported symbol IS the function, so its
// first statement runs first, and its first statement is [ensureRuntime] —
// which runs _initialize exactly once, through the linker symbol TinyGo gives
// it. That is the whole trick, and it is why every export below is one
// statement long: anything before ensureRuntime that allocated would allocate
// against a heap whose start and end are both still zero.

package archkeeprule

import "unsafe"

// wasmEntryReactor is the function TinyGo exports as _initialize under
// -buildmode=c-shared, which the wasm-unknown target sets. It initialises the
// heap (heapStart, heapEnd), seeds the runtime, and runs every package's init
// function — including the one an author calls [Register] from.
//
// Reached by its linker symbol because it is unexported in TinyGo's runtime and
// there is no exported spelling of it. The dependency is a loud one: a TinyGo
// that renamed the symbol fails the LINK, naming it, rather than producing an
// artifact that traps in a consumer's tree.
//
//go:linkname wasmEntryReactor _initialize
func wasmEntryReactor()

// wasmMemorySize invokes the memory.size instruction, answering the current
// size of this module's linear memory in 64 KiB pages.
//
// Declared by the LLVM intrinsic's own symbol name, the same way TinyGo's
// runtime declares it (src/runtime/arch_tinygowasm.go in a TinyGo
// installation). It is what [evidenceSlice] bounds-checks against, and it is
// read fresh on every call because a call that grew memory changes the answer.
//
//export llvm.wasm.memory.size.i32
func wasmMemorySize(index int32) int32

// wasmPageSize is WebAssembly's only unit of memory change.
const wasmPageSize = 64 * 1024

// runtimeStarted records whether _initialize has run in this instance.
//
// A package-level bool with no initialiser, which is the one kind of state
// readable before the runtime exists: it lives in the module's zero-filled data
// region, so reading it takes no code and it is false at instantiation.
var runtimeStarted bool

// pinned holds every buffer handed to the host as a bare integer — see this
// file's header.
var pinned [][]byte

// ensureRuntime starts the Go runtime, once, before anything allocates.
func ensureRuntime() {
	if runtimeStarted {
		return
	}
	// Set before the call, not after: wasmEntryReactor runs every package's init
	// function, and an init that reached back into an export would otherwise
	// start the runtime a second time and re-run every initializer.
	runtimeStarted = true
	wasmEntryReactor()
}

// alloc reserves size zeroed, writable bytes and answers with the pointer the
// host writes the evidence bundle at.
//
// It panics when the host asks a negative length, which is a trap the host
// names (../archkeep/src/custom-rules/host.mjs, outcomeReason's "trap" arm) —
// the loud direction, rather than a pointer the host would write through into
// nothing.
func alloc(size int32) int32 {
	if size < 0 {
		panic("archkeep_alloc: the host asks a non-negative length")
	}
	buffer := make([]byte, size)
	pinned = append(pinned, buffer)
	if size == 0 {
		// An empty slice has no first element to take the address of. The host
		// never asks for one — an evidence bundle is never empty — and answering
		// 0 rather than trapping keeps that unreachable case from being the
		// loudest thing in this file.
		return 0
	}
	return int32(uintptr(unsafe.Pointer(unsafe.SliceData(buffer))))
}

// pack pins bytes and packs their pointer and length into the i64 the ABI
// returns: (pointer << 32) | length.
func pack(text string) int64 {
	buffer := []byte(text)
	if len(buffer) == 0 {
		// Unreachable: a describe and a verdict are both non-empty documents. The
		// host reads the empty range as text that is not JSON and refuses by name,
		// which is a better answer than a pointer into nothing.
		return 0
	}
	pinned = append(pinned, buffer)
	pointer := uint32(uintptr(unsafe.Pointer(unsafe.SliceData(buffer))))
	return int64(uint64(pointer)<<32 | uint64(uint32(len(buffer))))
}

// evidenceSlice is the evidence bytes the host wrote at ptr..ptr+length.
//
// The range is checked against this module's own linear memory before a byte of
// it is read, so a caller that got it wrong traps here rather than reading
// whatever happens to be at that address. The caller the ABI has is the host,
// which passes exactly the pointer a preceding [alloc] answered with and the
// length it wrote there.
func evidenceSlice(ptr, length int32) []byte {
	if ptr < 0 || length < 0 {
		panic("archkeep_evaluate: a negative pointer or length is not a range")
	}
	memoryBytes := uint64(uint32(wasmMemorySize(0))) * wasmPageSize
	if uint64(uint32(ptr))+uint64(uint32(length)) > memoryBytes {
		panic("archkeep_evaluate: the evidence range reaches past this module's own linear memory")
	}
	// The uintptr-to-Pointer conversion go vet's unsafeptr check warns about, and
	// the one case where it is the point: the host hands over an address as an
	// integer, which is the only thing an ABI of i32s can carry. The bounds check
	// above is what stands in for the guarantee the conversion loses.
	return unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), int(length))
}

//export archkeep_alloc
func archkeepAlloc(size int32) int32 {
	ensureRuntime()
	return alloc(size)
}

//export archkeep_describe
func archkeepDescribe() int64 {
	ensureRuntime()
	return pack(DescribeJSON())
}

//export archkeep_evaluate
func archkeepEvaluate(ptr, length int32) int64 {
	ensureRuntime()
	return pack(EvaluateJSON(evidenceSlice(ptr, length)))
}
