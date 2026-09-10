---
name: tune-system
description: Resume calibration of Brandon's stereo (Evolution Acoustics MM2) with REW on studious.local — rig wiring, SSH tunnel, HQPlayer chain, sweep workflow, EQ derivation and export, known bugs. Use when the user wants to measure, sweep, EQ, tune, or calibrate the system, verify filters, or "get back to where we were" with REW.
---

# Tuning Brandon's system

You are resuming an ongoing calibration of a real, working hi-fi. Everything here
was verified live on 2026-09-09. Read values back after every write; twice in that
session a remembered interface turned out wrong and the repo rule — never script
against an interface you haven't run — earned its keep.

## The rig

- **REW 5.40 Beta 132 (API 0.9.6, Pro licensed)** runs on **studious.local** (Mac
  Studio), at `/Applications/REW-540-api/REW.app`. Do NOT touch the user's 5.31
  install at `/Applications/REW`. Relaunch:
  `ssh studious.local open -a /Applications/REW-540-api/REW.app --args -api`
- This laptop reaches the API through an SSH tunnel; the MCP server needs no config:
  `ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:4735:127.0.0.1:4735 studious.local`
  If tools report REW unreachable, the tunnel died — re-run that command. Never set
  REW_API_URL to the LAN address: the REW API has zero auth and exposes filesystem
  paths. Tunnel or nothing.
- **Signal chain (playback = measurement)**: REW → **BlackHole 2ch** → **HQPlayer 5
  Desktop** (input: BlackHole via coreaudio; upsamples to DSD256; EQ goes in its
  convolution engine) → **xCORE USB Audio 2.0 Output** → Evolution Acoustics MM2
  (full-range). HQPlayer config: `~/.hqplayer/settings.xml` on studious.
- **Mic**: UMIK-1 serial **7135194**, 90° cal file
  `/Users/bmf/Documents/REW/cal/7135194_90deg.txt`, input channel 2, mic at LP
  pointed at ceiling. There are two UMIK-1s and USB serials read identically —
  the other (7109804) belongs to the SHD; software cannot tell them apart.
- REW enumerates audio devices at startup. A device powered on after launch is
  invisible until REW restarts.
- Reference level: 81.8 dBA at LP is the user's stated maximum. Room noise floor
  43.0 dBA. Generator level −12 dBFS.

## Standing rules (the user's, not defaults)

- **ALWAYS sweep L and R separately.** Select the channel, read it back, sweep,
  then switch and repeat:
  `POST /audio/java/output-channel {"channel":"L"|"R"}` — verify with GET before
  each sweep. Never sweep both channels together; per-channel asymmetry is the
  entire point of this work, and a combined sweep hides it silently.
- **Save after every session**: `save_all_measurements` to
  `/Users/bmf/Documents/REW/measurements/<date>_LP_L-R*.mdat` (paths are on
  studious). Quitting REW discards unsaved measurements — one was lost that way.
  Save before you report a session done, not after.
- The couch in front of the right speaker **cannot move**. It absorbs right-channel
  HF (sharp onset ~3 kHz); the fix is EQ, and the user was blunt — do not suggest
  moving it again.

## Sweep workflow

1. `status`, then `list_measurements` — note existing UUIDs.
2. Channel L (verify by read-back) → `run_sweep` 512k, −12 dBFS, name it
   descriptively, notes include the chain.
3. **Ignore `run_sweep`'s return value.** It reports `completed:true` and hands
   back whatever measurement is newest *at call time* — a stale one, twice in one
   session. You will see a plausible measurement object and think "there it is."
   It isn't. Poll `GET /measurements` until a UUID appears that was not in your
   step-1 list; that diff is the only trustworthy identity of the new sweep.
4. Channel R (verify) → sweep → poll again.
5. Compare / EQ, then **save the .mdat**.

Session config that is already set and should stay: acoustic timing reference,
`startDelaySeconds: 3` (the HQPlayer/DSD pipeline eats sweep onsets without it —
the first HQP sweep lost 5 dB of sub-bass to stream startup), dither fill on,
clipping abort on.

If REW refuses a sweep with "measurement in progress": `clear_command_in_progress`,
and if that says none, `POST /measure/command {"command":"Cancel"}`.

## Deriving EQ

- **EQ is derived from sweeps through the full HQPlayer chain, never from
  direct-to-DAC sweeps.** This is settled, and it will tempt you: the direct
  sweeps look cleaner and are already sitting in the .mdat, and you will think
  "the chain is just an upsampler, the old sweeps will do." Measured fact says
  otherwise: the chain is highly repeatable (±0.1 dB) but NOT transparent —
  bass −5..−9 dB, treble +1.5(L)/+3(R) vs direct. EQ built on the wrong chain
  ships a wrong-sounding correction with no error message anywhere. Measure the
  chain the user listens through.
- `eq_match_target_settings` defaults are subwoofer settings (20–100 Hz, shelves
  off). For full-range flat, set explicitly and read back:
  20–20000 Hz, individualMaxBoostdB 6, flatnessTargetdB 2, shelves allowed ±6,
  varyQAbove200Hz true. Confirm no house curve and `addRoomCurve:false`.
- `auto_eq` per channel, Generic/Generic, shape "Full range". Let REW compute the
  target level for L, read it via `get_target_response`, then pass that exact
  value as `targetLevelDb` for R — same absolute target on both channels is what
  fixes the L/R imbalance without touching balance controls.
- Nulls stay. REW correctly refuses to boost into position/modal nulls; residual
  deviation at the nulls is not a failure to fix.

## Exporting filters to HQPlayer

`GET /measurements/{uuid}/filters-impulse-response?samplerate=48000&length=65536`
returns JSON with base64 **big-endian float32** samples (verify your decode against
`get_filters_impulse_response`'s `peakSample`). Build mono float32 WAVs (fmt tag 3),
one per channel, 48k and 44.1k renders. Compute each IR's max frequency-domain gain
via FFT and apply **one common scale to all files** putting the worst below unity —
per-file normalization would silently skew L/R balance. Deliver to
`~/Documents/REW/filters/` on studious; HQPlayer loads them under Settings → DSP →
Convolution, LEFT→channel 0, RIGHT→channel 1. Then verify: re-sweep both channels
through the chain and compare against the flat target.

## Known MCP bugs (open as of 2026-09-09)

- `run_sweep` stale return — see workflow step 3.
- `smooth_measurement` enum wrong: REW wants `Var`/`Psy`, ours sends
  `Variable`/`Psychoacoustic` (400). Valid set: 1/1..1/48, Var, Psy, ERB, None.
  Command bodies nest as `{command, parameters:{...}}`.
- `analyze_response` reads unsmoothed data; smoothing changes the graph but not
  its output.
- `spl_meter_config` keys are `splWeighting`/`filter`/`highPassActive`; wrong keys
  are silently dropped.
- SPL meter can wedge and read −180 while `input_levels` works — trust
  `input_levels` (SPL ≈ 94 + rms − (−28.2), the mic's dBFS@94 figure).

## Data on studious

`~/Documents/REW/measurements/2026-09-09_LP_L-R_EQ.mdat` holds the session:
direct-xCORE baselines (L `4b486853…`, R `7711f507…`), via-HQP EQ basis pair
(L `aab03723…`, R `8ced5121…`, both with 3s start delay), and the auto-EQ filter
banks (flat target 76.48 dB SPL). Filter WAVs: `~/Documents/REW/filters/
HQP-chain-flat-{LEFT,RIGHT}-{48000,44100}.wav`.
