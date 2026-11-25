#!/bin/sh
set -eu
status=$(paseo plugin ls paseo-task-manager --json | node -e '
let input = "";
process.stdin.on("data", part => { input += part; });
process.stdin.on("end", () => {
  const list = JSON.parse(input);
  process.stdout.write(list.find(plugin => plugin.id === "paseo-task-manager")?.status ?? "");
});')
if [ "$status" = failed ]; then
  printf '%s\n' 'paseo-task-manager failed, reloading'
  paseo plugin reload paseo-task-manager >/dev/null
fi
