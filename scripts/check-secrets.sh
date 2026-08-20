#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
mode="scan"
scan_path=""

case "${1:-}" in
  "") ;;
  --self-test)
    [[ $# -eq 1 ]] || { echo "usage: $0 [--self-test | --path PATH]" >&2; exit 2; }
    mode="self-test"
    ;;
  --path)
    [[ $# -eq 2 ]] || { echo "usage: $0 [--self-test | --path PATH]" >&2; exit 2; }
    mode="path"
    scan_path="$2"
    ;;
  *)
    echo "usage: $0 [--self-test | --path PATH]" >&2
    exit 2
    ;;
esac

assignment_re="['\"]?(authorization|cookie|set-cookie|qm_keyst|qrsig|ptqrtoken|access_token|refresh_token|refresh_key|musickey|openid|unionid|uin|musicid|str_musicid|callback_url)['\"]?[[:space:]]*[:=][[:space:]]*(\"([^\"]*)\"|'([^']*)'|[Bb]earer[[:space:]]+([^[:space:]\",;]+)|(\[REDACTED\]|[^[:space:]\",;]+))"
signed_url_re='[?&](vkey|token|sig|key)=([A-Za-z0-9._~%+-]{8,})'
shopt -s nocasematch

is_safe_value() {
  local candidate="$1"
  candidate="${candidate#${candidate%%[![:space:]]*}}"
  candidate="${candidate%${candidate##*[![:space:]]}}"
  if [[ "$candidate" =~ ^[Bb]earer[[:space:]]+(.+)$ ]]; then
    candidate="${BASH_REMATCH[1]}"
  fi
  case "$candidate" in
    ""|'[REDACTED]'|'%5BREDACTED%5D'|redacted|SECRET|SANITIZED_*|'$'*|'%'*'%'|'<'*'>') return 0 ;;
    *) return 1 ;;
  esac
}

scan_line() {
  local line="$1"
  local display_path="$2"
  local line_number="$3"
  local findings=0
  local remaining="$line"
  while [[ "$remaining" =~ $assignment_re ]]; do
    local matched="${BASH_REMATCH[0]}"
    local field="${BASH_REMATCH[1]}"
    local value="${BASH_REMATCH[3]:-${BASH_REMATCH[4]:-${BASH_REMATCH[5]:-${BASH_REMATCH[6]:-}}}}"
    if ! is_safe_value "$value"; then
      printf '%s:%s: assigned %s value\n' "$display_path" "$line_number" "$field" >&2
      findings=1
    fi
    remaining="${remaining#*"$matched"}"
    [[ -n "$matched" ]] || break
  done
  remaining="$line"
  while [[ "$remaining" =~ $signed_url_re ]]; do
    local matched="${BASH_REMATCH[0]}"
    local value="${BASH_REMATCH[2]}"
    if ! is_safe_value "$value"; then
      printf '%s:%s: signed URL query value\n' "$display_path" "$line_number" >&2
      findings=1
    fi
    remaining="${remaining#*"$matched"}"
    [[ -n "$matched" ]] || break
  done
  return "$findings"
}

scan_text() {
  local text="$1"
  local display_path="$2"
  local line_number=0
  local failed=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    scan_line "$line" "$display_path" "$line_number" || failed=1
  done <<< "$text"
  return "$failed"
}

scan_file() {
  local path="$1"
  local display_path="$2"
  local failed=0
  local line_number=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    scan_line "$line" "$display_path" "$line_number" || failed=1
  done < "$path"
  return "$failed"
}

if [[ "$mode" == "self-test" ]]; then
  secret_tail='value-12345678'
  cookie_case='"cookie":"session-'"$secret_tail"'"'
  url_case='https://example.invalid/media?v''key=token-12345678'
  second_field_case='"uin":"SANITIZED_ACCOUNT","refresh_''token":"session-'"$secret_tail"'"'
  if scan_text "$cookie_case" '<self-test>' 2>/dev/null; then
    echo 'secret scanner self-test did not reject the cookie case' >&2
    exit 1
  fi
  if scan_text "$url_case" '<self-test>' 2>/dev/null; then
    echo 'secret scanner self-test did not reject the signed URL case' >&2
    exit 1
  fi
  if scan_text "$second_field_case" '<self-test>' 2>/dev/null; then
    echo 'secret scanner self-test did not reject a later assigned field' >&2
    exit 1
  fi
  for safe_case in \
    'qm_keyst' \
    'qm_keyst=[REDACTED]' \
    '"uin":"SANITIZED_ACCOUNT"' \
    'https://qpic.y.qq.com/synthetic.png'; do
    if ! scan_text "$safe_case" '<self-test>'; then
      echo "secret scanner self-test rejected a safe case: $safe_case" >&2
      exit 1
    fi
  done
  echo 'secret scanner self-test passed'
  exit 0
fi

failed=0
if [[ "$mode" == "path" ]]; then
  scan_file "$scan_path" "$scan_path" || failed=1
else
  cd "$repo_root"
  while IFS= read -r -d '' path; do
    scan_file "$repo_root/$path" "$path" || failed=1
  done < <(git ls-files -z --cached --others --exclude-standard -- README.md docs tests/fixtures)
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo 'account secret scan passed'
