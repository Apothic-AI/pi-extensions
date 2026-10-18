# Task and status navigation

These are presentation surfaces, not another execution coordinator:

- `/background` or **Ctrl+Alt+B** opens the shell-job roster. Enter opens the
  selected job's wrapped overview, then Enter or `l` opens its logs. Escape moves
  back through logs, overview and roster. `/background view <id>` opens logs
  directly. Stop/clear still require explicit confirmation.
- **Ctrl+Alt+S** or `/statusline inspect` selects extension statuses. Enter opens
  an opted-in owner's existing UI; unknown statuses show sanitized text instead.
  This does not hide statuses or change settings. The shortcut declines when an
  overlay, autocomplete or an unrecognized focused component owns input; the
  command remains available.
- Workflows keeps its existing navigator and Agent-style Fleet interaction.
  Expandable workflow groups use `▸`, distinct from individual agent status
  marks. Fleet contributes one blank separator before the footer, not two.

Background and Workflows publish their own compact footer summaries. Notification
silence does not suppress Background's process-state refresh. Workflow run counts
come from run states, never inferred from completed child calls. Nothing opens a
view automatically on output, completion or status updates.

## Optional status-action wire contract, version 1

Producers and consumers communicate only through `pi.events`. They do not import
another extension's source, infer slash commands from a status key, submit model
messages, or expose execution controls through this channel.

Channels:

- `pi-ui:status-actions:v1:query`
- `pi-ui:status-actions:v1:open`
- Replies: `<channel>:reply:<requestId>`

Query request:

```json
{"version":1,"requestId":"request","sessionId":"session"}
```

Successful discovery reply:

```json
{
  "success":true,
  "data":{
    "version":1,
    "providerId":"pi-background",
    "surfaceId":"opaque-activation-id",
    "sessionId":"session",
    "entries":[{"statusKey":"pi-background","actionId":"tasks","label":"Background tasks"}]
  }
}
```

Open request:

```json
{"version":1,"requestId":"request","providerId":"pi-background","surfaceId":"opaque-activation-id","sessionId":"session","actionId":"tasks"}
```

Successful open reply is `{"success":true,"data":{"accepted":true}}`. This
acknowledges **admission**, not successful rendering or eventual dialog completion.
The producer retains authority over opening and retiring its view. Requests for
another provider, session or surface are ignored, not answered on its behalf.

Records must have exactly their declared own data fields. Accessors, inherited
fields and malformed values confer no action. Identifiers are nonempty strings
of at most 128 characters; status keys and labels allow 512. Discovery bounds
snapshots to 32 providers and 64 total entries. Conflicting snapshots or multiple
owners for one status key are not selectable actions. The consumer discovers on
explicit entry, subscribes before querying, collects for 50 ms, and revalidates
before opening. There is no persistent registration cache or load-order mandate.
Open waits at most two seconds for admission. Cancellation removes listeners and
timers; identifiers remain original data while display copies are sanitized.

A surface belongs to one active TUI session/branch. Producers rotate it on
committed navigation/reload and check live branch ancestry both at admission and
mount. Ordinary appends remain valid; a replaced branch cannot resurrect an old
surface. The consumer fully disposes its selector before handing focus to the
producer. This bus is an optional same-process UI convention, not sender
authentication, an approval grant, process control or a security sandbox.

## Verification boundaries

Focused tests cover the wire validators, delayed replies/mounts, selection
identity, disposal, native selection bindings, bounded logs and paused snapshots.
The private root integration suite loads Background, Subagents, Workflows and
Statusline through the public resource loader in both extension orders and both
TUI renderers. It checks owner UI activation, draft preservation, unchanged
settings and composed Fleet/footer spacing without a model call.

`python3 packages/pi-background/test/shortcut-cli.py` exercises the actual CLI in
regular/fullscreen modes, including native shortcuts, foreign dialogs, draft and
cursor restoration, live resize, real shell logs and confirmed stop. Set
`PI_TEST_CLI` to another installed CLI entrypoint for an explicit host lane.
Widths of one/two cells are component-tested; the complete Pi 1.0.4 editor can
recurse while wrapping a wide draft at one column, so real CLI resize acceptance
uses a minimum of 20 columns. Committed CJK/paste checks are not physical-terminal
IME/preedit qualification. These checks do not establish live-provider/OAuth,
external-LSP or every-platform compatibility.
