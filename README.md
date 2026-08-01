# room-eq-wizard-mcp

An MCP server that connects LLMs to [Room EQ Wizard](https://www.roomeqwizard.com) (REW): typed control of REW's HTTP API plus local acoustic analysis that reduces measurement data to something a model can reason about.

REW is the DSP engine — sweeps, RT60, averaging, EQ optimization all run inside REW, and this server drives them through the API. What the server adds is the layer REW doesn't have: peak/null detection with Q factors and severity, per-band statistics, before/after comparison, room-mode prediction correlated against measurements, and log-decimated curves sized for an LLM context instead of megabytes of base64.

## Requirements

- **Node.js 20+**
- **REW 5.40+** running with its API server enabled:
  - macOS: `open -a REW.app --args -api`
  - Windows: `roomeqwizard.exe -api`
  - or enable it in REW **Preferences → API**
- API-triggered *measurement* (`run_sweep`) additionally requires a [REW Pro upgrade](https://www.roomeqwizard.com/upgrades.html); every read/analysis/EQ tool works without it.

## Install

```jsonc
// Claude Desktop (claude_desktop_config.json) or any MCP client config
{
  "mcpServers": {
    "rew": {
      "command": "npx",
      "args": ["-y", "room-eq-wizard-mcp"]
    }
  }
}
```

```bash
# Claude Code
claude mcp add rew -- npx -y room-eq-wizard-mcp
```

The REW API address defaults to `http://127.0.0.1:4735`; override with the `REW_API_URL` environment variable if you run REW on another port.

## Tools (46)

| Area | Tools |
|---|---|
| Status | `status`, `list_api_commands` |
| Measurements | `list_measurements`, `get_measurement`, `rename_measurement`, `delete_measurement`, `save_all_measurements`, `load_measurement_files`, `run_measurement_command`, `get_measurement_commands` |
| Groups | `list_groups`, `create_group`, `update_group`, `delete_group`, `add_measurements_to_group`, `get_group_measurements` |
| Data | `get_frequency_response`, `get_rt60`, `get_distortion` |
| Measuring | `run_sweep` |
| Import | `import_frequency_response`, `import_impulse_response`, `import_frequency_response_data`, `import_impulse_response_data`, `import_rta_file`, `import_sweep_recordings` |
| Signal generator | `generator` |
| SPL meter | `read_spl` |
| EQ | `auto_eq`, `get_eq_filters`, `set_eq_filters`, `get_predicted_response`, `list_equalisers` |
| Processing | `average_measurements`, `align_spl`, `arithmetic`, `smooth_measurement`, `add_spl_offset` |
| Alignment | `align_measurements`, `create_aligned_sum`, `get_alignment_state`, `configure_alignment`, `run_alignment_command` |
| Analysis | `analyze_response`, `compare_measurements`, `room_mode_analysis` |

Typical session: `status` → `run_sweep` (or `load_measurement_files`) → `analyze_response` → `room_mode_analysis` with your room dimensions → `auto_eq` → `compare_measurements` on the predicted result.

## Architecture

```
src/rew/       the only layer that talks to REW
  codec.ts       base64 big-endian float32 <-> arrays (REW's wire format)
  types.ts       Zod schemas — raw JSON is parsed once at this boundary
  client.ts      HTTP client; enables REW blocking mode once for long commands
src/analysis/  pure functions, no I/O, no mocks needed to test
  spectrum.ts    median-baseline peak/null detection, band stats, decimation
  room-modes.ts  rectangular-room modes, Schroeder frequency, correlation
src/tools/     MCP tools as data: one ToolDef type, one registration loop
```

Two properties worth knowing:

- **Everything REW computes stays REW's job.** RT60, averaging, EQ matching are invoked via the API, never reimplemented — the numbers you get through this server match what the REW GUI shows.
- **Long commands use REW's blocking mode**, enabled once per session. A sweep or EQ match returns when it finishes (client timeout 180 s). Note the blocking setting persists in REW across restarts.

## Development

```bash
pnpm install
pnpm test        # unit suite (mocked HTTP) + live suite that self-skips without REW
pnpm build
pnpm typecheck
```

With REW running (`-api`), the live integration tests in `src/rew/live.integration.test.ts` activate automatically.

## Credits

Design informed by two earlier REW MCP servers: [koltyj/REW-mcp](https://github.com/koltyj/REW-mcp) (analysis depth, typed client patterns) and [KevinMeinon/rew-mcp-server](https://github.com/KevinMeinon/rew-mcp-server) (API coverage philosophy and field-tested REW payload shapes, plus its excellent REW API reference doc). REW itself is © John Mulcahy.

## License

MIT
