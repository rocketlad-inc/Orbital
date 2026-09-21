// The resvg WebAssembly, as the Worker loads it: wrangler turns a .wasm
// import into a compiled WebAssembly.Module.
//
// KEPT IN ITS OWN FILE ON PURPOSE. Nothing else may import this
// statically, because the node simulations share every other widget
// module and node cannot import a .wasm file. The battle route pulls it
// in with a dynamic import and hands it to shipIconRaster; the sims hand
// over the raw bytes instead.
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';

export default resvgWasm;
