# Session sync for agent-pm

Choose which Paseo hosts contribute sessions to your agent-pm project board. The plugin runs on the machine hosting the center and continues collecting when the app is closed.

The collector reads sessions on the local daemon and hosts registered with that daemon. It sends session metadata, conversation text and bounded tool input/output to your configured agent-pm center. That center may use its own model provider to summarize the conversations. Each source resumes from the last position acknowledged by the center.

## Setup

Use Paseo 0.17.0 or later, Node 26 or later and an existing agent-pm center. The state directory uses local filesystem locking on macOS or Linux. Git installation needs npm to retrieve the locked dependencies and build the plugin. Configure the center URL, daemon and source IDs and a token file for each source on the collecting machine. Keep tokens readable only by the daemon account. See the [configuration and setup guide](README.md).

## Collection settings

Select individual hosts or all known hosts. By default, closed and archived sessions contribute metadata only. You can opt into reading their history and watch the import progress in settings. Reading a stored session can load its provider runtime. Archived sessions retain their archive status.

The trusted plugin uses the daemon account's filesystem and network access to read its configuration, store locks, cache and pending batches, inspect repository state and send data to the center. Repository changes are reported as counts. If the optional checkout API is unavailable, session collection continues. The plugin sends no prompts to agents.
