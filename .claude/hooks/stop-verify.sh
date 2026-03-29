#!/bin/sh
# Stop hook: run build, tests, and type checks if code changed since last commit
cd "$(git rev-parse --show-toplevel)" || exit 0

# Skip if no source changes vs remote (uncommitted or committed-but-unpushed)
remote_ref=$(git rev-parse --verify origin/main 2>/dev/null || echo "")
if [ -n "$remote_ref" ]; then
  if git diff --quiet "$remote_ref" -- 'packages/*/src/**' && git diff --quiet -- 'packages/*/src/**'; then
    exit 0
  fi
else
  if git diff --quiet HEAD -- 'packages/*/src/**'; then
    exit 0
  fi
fi

echo "Running build..."
pnpm -r build 2>&1
if [ $? -ne 0 ]; then
  echo "Build failed."
  exit 1
fi

echo "Running tests..."
npx vitest run 2>&1
if [ $? -ne 0 ]; then
  echo "Tests failed."
  exit 1
fi

echo "Running type checks..."
tsc_failed=0
for pkg in sdk build runtime web addon; do
  echo "  tsc: packages/$pkg"
  (cd "packages/$pkg" && npx tsc --noEmit 2>&1)
  if [ $? -ne 0 ]; then
    tsc_failed=1
  fi
done

if [ $tsc_failed -ne 0 ]; then
  echo "Type check failed."
  exit 1
fi

echo "All checks passed."
exit 0
