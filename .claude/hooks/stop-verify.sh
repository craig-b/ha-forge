#!/bin/sh
# Stop hook: run build, tests, and type checks if code changed since last commit
cd "$(git rev-parse --show-toplevel)" || exit 0

# Skip if no uncommitted changes to source files
if git diff --quiet HEAD -- 'packages/*/src/**'; then
  exit 0
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
