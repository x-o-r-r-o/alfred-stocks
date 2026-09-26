#!/bin/bash
# Stand-in for /usr/bin/security used by the tests (never touches a real keychain).
# Stores each password in $FAKE_KEYCHAIN/<service>.<account> and logs argv to $FAKE_KEYCHAIN/log.
cmd=$1; shift
printf '%s\n' "$cmd $*" >> "$FAKE_KEYCHAIN/log"
s=""; a=""; pw=""
while [ $# -gt 0 ]; do
  case $1 in
    -s) s=$2; shift 2 ;;
    -a) a=$2; shift 2 ;;
    -l) shift 2 ;;
    -w) if [ "$cmd" = find-generic-password ]; then shift; else pw=$2; shift 2; fi ;;
    *) shift ;;
  esac
done
f="$FAKE_KEYCHAIN/$s.$a"
case $cmd in
  find-generic-password) [ -f "$f" ] || exit 44; cat "$f"; echo ;;
  add-generic-password) printf '%s' "$pw" > "$f" ;;
  delete-generic-password) [ -f "$f" ] || exit 44; rm "$f" ;;
  *) exit 1 ;;
esac
