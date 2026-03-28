#!/bin/sh
# PreToolUse hook: reject Edit/Write calls that contain unsafe type casts
# Reads the tool input JSON from stdin and checks for bad patterns

input=$(cat)

# Extract the content being written (new_string for Edit, content for Write)
text=$(echo "$input" | jq -r '.tool_input.new_string // .tool_input.content // empty')

if [ -z "$text" ]; then
  exit 0
fi

# Check for bad cast patterns in .ts files only
file=$(echo "$input" | jq -r '.tool_input.file_path // empty')
case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

if echo "$text" | grep -qE 'as unknown as |as any[ ;,)\n]|: any[ ;,)\n]'; then
  echo "Unsafe cast detected (as unknown as / as any). Fix the types properly instead."
  exit 2
fi

exit 0
