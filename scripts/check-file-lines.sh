#!/bin/sh
set -eu

warning_limit=220
hard_limit=250
failed=0

files=$(find cmd internal -type f -name '*.go' ! -name '*_test.go' | sort)
for file in $files; do
  lines=$(wc -l < "$file" | tr -d ' ')
  if [ "$lines" -gt "$hard_limit" ]; then
    echo "ERROR: $file has $lines lines; hard limit is $hard_limit"
    failed=1
  elif [ "$lines" -gt "$warning_limit" ]; then
    echo "WARN: $file has $lines lines; target is $warning_limit"
  fi
done

exit "$failed"
