#!/bin/sh
# Stop hook: run build, tests, and type checks before stopping
# Outputs JSON to block Claude from stopping if checks fail
cd "$(git rev-parse --show-toplevel)" || exit 0

# Skip if no source changes vs remote (uncommitted or committed-but-unpushed)
remote_ref=$(git rev-parse --verify origin/main 2>/dev/null || echo "")
check_paths='packages/*/src/** packages/*/package.json packages/*/tsconfig.json tsconfig.base.json pnpm-lock.yaml'
if [ -n "$remote_ref" ]; then
  if git diff --quiet "$remote_ref" -- $check_paths && git diff --quiet -- $check_paths; then
    exit 0
  fi
else
  if git diff --quiet HEAD -- $check_paths; then
    exit 0
  fi
fi

errors=""

pnpm -r build 2>&1
if [ $? -ne 0 ]; then
  errors="${errors}Build failed.\n"
fi

npx vitest run 2>&1
if [ $? -ne 0 ]; then
  errors="${errors}Tests failed.\n"
fi

tsc_failed=0
for pkg in sdk build runtime web addon; do
  (cd "packages/$pkg" && npx tsc --noEmit 2>&1)
  if [ $? -ne 0 ]; then
    tsc_failed=1
  fi
done
if [ $tsc_failed -ne 0 ]; then
  errors="${errors}Type check failed.\n"
fi

if [ -n "$errors" ]; then
  printf '{"continue":false,"stopReason":"Pre-push checks failed:\\n%s\\nFix these before stopping."}\n' "$errors"
  exit 0
fi

exit 0
