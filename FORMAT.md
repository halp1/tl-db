# TLR replay format

The reference implementation is `src/common/codec.ts`. Decoding a file gives exactly the value the old msgpackr pipeline stored, including key order and the float32 rounding.

## Container

```
"TLR" (54 4C 52)  version u8  section*
section = method u8, length varint, payload
```

Varints are unsigned LEB128.

Section methods:

| id | method |
|---|---|
| 0 | raw |
| 1 | brotli |
| 2 | zstd |
| 3 | zstd with the version 1 dictionary (`src/common/codec-dict-v1.bin`, also served at `/codec/dict-v1.bin`) |

Files without the magic are legacy msgpackr data packed with `bundleStrings, useRecords, structuredClone, useFloat32: 3, moreTypes: false`.

## Version 0

A single section holding the legacy msgpackr bytes. The encoder uses this only as a fallback.

## Version 1

There are five sections, in this order.

1. `codes`: one byte per key event, `keyIndex * 2 + (keyup ? 1 : 0)`.
2. `deltas`: one varint per key event, the frame minus the previous key event's frame in the same round player (starting from 0).
3. `subs`: one byte per key event, `subframe * 10`, plus 16 when `hoisted: true`.
4. `counts`: one varint per round player, the number of key events.
5. `body`: msgpackr (`useRecords: false, structuredClone: true, useFloat32: 3, moreTypes: false`) of the replay, with each round player's `events` replaced by entries.

Key indices: `moveLeft moveRight softDrop hardDrop rotateCW rotateCCW rotate180 hold retry exit undo`.

Round players are every `replay.rounds[i][j]` whose `replay.events` is an array, in order.

### Body entries

Key event `k` in a round player is preceded by the entries whose `keysBefore` equals `k`. The entries with `keysBefore == count` come after the last key event.

| entry | meaning |
|---|---|
| `[keysBefore, event]` | the event as is |
| `[keysBefore, event, 1, patches]` | an `end` or `full` event with fields removed (see below) |
| `[keysBefore, [frame, id], 2, iid]` | `{frame, type: "ige", data: {id, frame: I.frame, type: "interaction_confirm", data: I.data}}`, where `I` is the most recent earlier `interaction` ige payload with `data.iid == iid` |

Each patch is `[planIndex, originalKeys, droppedIndices]`. To rebuild the object at the plan's path, walk `originalKeys` in order and take each dropped key's value from the reference. Apply patches in reverse order.

| event | plan | path | reference |
|---|---|---|---|
| end | 0 | `data` | `results.gameoverreason`, `results.stats`, `results.aggregatestats` |
| end | 1 | `data.options` | the round player's `replay.options` |
| end | 2 | `data.game` | `{handling: options.handling}` |
| full | 0 | `data.game` | `{handling: options.handling}` |

Version 1 is frozen, including its dictionary. Any change to the dictionary, the key table order or the rules above needs a new version number.
