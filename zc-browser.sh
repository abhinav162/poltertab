#!/usr/bin/env bash
# zc-browser.sh — CLI wrapper to send commands to ZeroClaw bridge server
# Usage: ./zc-browser.sh <action> [params as key=value pairs]
#
# Examples:
#   ./zc-browser.sh navigate url=https://google.com
#   ./zc-browser.sh click selector="#submit-btn"
#   ./zc-browser.sh fill selector="#email" value="user@example.com"
#   ./zc-browser.sh scrape selector="h1" multiple=true
#   ./zc-browser.sh screenshot
#   ./zc-browser.sh scroll direction=down amount=500
#   ./zc-browser.sh hover selector=".menu-item"
#   ./zc-browser.sh get_text selector="#content"
#   ./zc-browser.sh get_title
#   ./zc-browser.sh health

set -euo pipefail

BRIDGE_HOST="${ZC_BRIDGE_HOST:-localhost}"
BRIDGE_PORT="${ZC_BRIDGE_PORT:-7823}"
BASE_URL="http://${BRIDGE_HOST}:${BRIDGE_PORT}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
  cat <<EOF
${CYAN}PolterTab Browser Control${NC}

Usage: $(basename "$0") <action> [key=value ...]

Actions:
  navigate    url=<url>                          Navigate to URL
  click       selector=<sel>                     Click an element
  fill        selector=<sel> value=<text>         Fill an input field
  scrape      [selector=<sel>] [multiple=true]   Scrape page/elements
  screenshot                                      Capture visible tab
  scroll      [direction=down] [amount=500]      Scroll the page
  hover       selector=<sel>                     Hover over element
  get_text    selector=<sel>                     Get element text
  get_title                                       Get page title + URL
  health                                          Check server status

Options:
  -h, --help    Show this help
  -r, --raw     Output raw JSON (no formatting)
  -q, --quiet   Suppress status messages

Environment:
  ZC_BRIDGE_HOST   Bridge server host (default: localhost)
  ZC_BRIDGE_PORT   Bridge server port (default: 7823)
EOF
  exit 0
}

# Parse flags
RAW=false
QUIET=false
while [[ $# -gt 0 && "$1" =~ ^- ]]; do
  case "$1" in
    -h|--help) usage ;;
    -r|--raw) RAW=true; shift ;;
    -q|--quiet) QUIET=true; shift ;;
    *) echo -e "${RED}Unknown flag: $1${NC}"; exit 1 ;;
  esac
done

if [[ $# -lt 1 ]]; then
  usage
fi

ACTION="$1"
shift

# Health check is a GET
if [[ "$ACTION" == "health" ]]; then
  response=$(curl -s -w "\n%{http_code}" "${BASE_URL}/health" 2>/dev/null) || {
    echo -e "${RED}Error: Cannot reach bridge server at ${BASE_URL}${NC}" >&2
    exit 1
  }
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if $RAW; then
    echo "$body"
  else
    echo -e "${GREEN}Bridge server status:${NC}"
    echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
  fi
  exit 0
fi

# Build JSON payload from key=value pairs
json_body="{\"action\":\"${ACTION}\""

for param in "$@"; do
  key="${param%%=*}"
  value="${param#*=}"

  # Detect booleans and numbers
  if [[ "$value" == "true" || "$value" == "false" ]]; then
    json_body="${json_body},\"${key}\":${value}"
  elif [[ "$value" =~ ^[0-9]+$ ]]; then
    json_body="${json_body},\"${key}\":${value}"
  else
    # Escape quotes in string values
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    json_body="${json_body},\"${key}\":\"${value}\""
  fi
done

json_body="${json_body}}"

if ! $QUIET; then
  echo -e "${CYAN}> ${ACTION}${NC} ${*}" >&2
fi

# Send command
response=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$json_body" \
  "${BASE_URL}/command" 2>/dev/null) || {
  echo -e "${RED}Error: Cannot reach bridge server at ${BASE_URL}${NC}" >&2
  exit 1
}

http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | sed '$d')

if $RAW; then
  echo "$body"
  exit 0
fi

# Parse success/error
success=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null || echo "")

if [[ "$success" == "True" ]]; then
  if ! $QUIET; then
    echo -e "${GREEN}OK${NC}" >&2
  fi
  echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
else
  error=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error', 'Unknown error'))" 2>/dev/null || echo "HTTP $http_code")
  echo -e "${RED}Error: ${error}${NC}" >&2
  echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
  exit 1
fi
