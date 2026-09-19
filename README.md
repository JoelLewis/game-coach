# GameCoach Web

A browser chess coach that runs entirely on Cloudflare. Stockfish (WASM) owns the truth about the position, TypeSafe's Jev model makes the coaching judgment after every move, and templates plus a small writing model supply the words.

- Product spec: [`docs/PRD.md`](docs/PRD.md)
- Architecture and build plan: [`docs/build-plan.md`](docs/build-plan.md)
- Contributor and agent rules: [`CLAUDE.md`](CLAUDE.md)

Status: Wave 0 (scaffold and Jev feasibility spike).

## Development

Requires Node 22+, pnpm 11+, Rust stable.

```
pnpm install
pnpm typecheck
cargo check
```

## License

GPL-3.0-only. See [`LICENSE`](LICENSE).
