// Rebuild when the web UI is rebuilt, so the binary embeds the current
// `web/dist` (and debug builds notice the folder appearing after the first
// `cargo build`). Cargo scans the directory recursively.
fn main() {
    println!("cargo:rerun-if-changed=../../web/dist");
}
