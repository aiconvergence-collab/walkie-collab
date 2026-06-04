#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="claude-website-chat"
DESKTOP_NAME="Claude Website Chat"
DESKTOP_FILE="${HOME}/.local/share/applications/${APP_NAME}.desktop"
ICON_NAME="claude-walkie"
ICON_DIR="${HOME}/.local/share/icons/hicolor/256x256/apps"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
DESKTOP_DIR="${DESKTOP_DIR:-${HOME}/Desktop}"
DESKTOP_SHORTCUT="${DESKTOP_DIR}/${APP_NAME}.desktop"
if [[ -z "${DESKTOP_DIR}" || "${DESKTOP_DIR}" == "N/A" ]]; then
  DESKTOP_DIR="${HOME}"
  DESKTOP_SHORTCUT="${HOME}/${APP_NAME}.desktop"
fi

mkdir -p "${HOME}/.local/share/applications" "${ICON_DIR}"
mkdir -p "${DESKTOP_DIR}"
mkdir -p "${HOME}/Desktop"

rm -f \
  "${HOME}/.local/share/applications/claude-code.desktop" \
  "${HOME}/.local/share/applications/claude-walkie.desktop" \
  "${HOME}/.local/share/applications/claude-code-walkie.desktop" \
  "${HOME}/.local/share/applications/walkie-collab-frankl.desktop" \
  "${HOME}/Desktop/claude-code.desktop" \
  "${HOME}/Desktop/claude-walkie.desktop" \
  "${HOME}/Desktop/walkie-collab-frankl.desktop" \
  "${DESKTOP_DIR}/claude-code.desktop" \
  "${DESKTOP_DIR}/claude-walkie.desktop" \
  "${DESKTOP_DIR}/walkie-collab-frankl.desktop"

install -m 644 "${ROOT_DIR}/assets/${ICON_NAME}.svg" "${ICON_DIR}/${ICON_NAME}.svg"

cat >"${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=${DESKTOP_NAME}
Comment=Open a desktop chat wrapper backed by Claude.ai
Path=${HOME}
Exec=${ROOT_DIR}/scripts/launch-claude-desktop-ui.sh
Icon=${ROOT_DIR}/assets/${ICON_NAME}.svg
Terminal=false
StartupNotify=true
Categories=Utility;
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${HOME}/.local/share/applications" 2>/dev/null || true
fi

chmod +x "${DESKTOP_FILE}"

safe_copy() {
  local src="$1"
  local dst="$2"
  if [[ ! -f "${src}" ]]; then
    return
  fi
  local src_real dst_real
  src_real="$(realpath "${src}")"
  dst_real="$(realpath -m "${dst}")"
  if [[ "${src_real}" != "${dst_real}" ]]; then
    cp "${src}" "${dst}"
  fi
}

safe_copy "${DESKTOP_FILE}" "${DESKTOP_SHORTCUT}"
chmod +x "${DESKTOP_SHORTCUT}" 2>/dev/null || true
if command -v gio >/dev/null 2>&1; then
  gio set "${DESKTOP_SHORTCUT}" "metadata::trusted" true >/dev/null 2>&1 || true
fi

echo "Installed:"
echo "  ${DESKTOP_FILE}"
if [[ -f "${DESKTOP_SHORTCUT}" ]]; then
  echo "  ${DESKTOP_SHORTCUT}"
fi
echo

# ── TUI desktop entry ──────────────────────────────────────────────────────
TUI_APP_NAME="claude-free-tui"
TUI_DESKTOP_NAME="Claude AI Free (TUI)"
TUI_DESKTOP_FILE="${HOME}/.local/share/applications/${TUI_APP_NAME}.desktop"
TUI_DESKTOP_SHORTCUT="${DESKTOP_DIR}/${TUI_APP_NAME}.desktop"

cat >"${TUI_DESKTOP_FILE}" <<TUIEOF
[Desktop Entry]
Version=1.0
Type=Application
Name=${TUI_DESKTOP_NAME}
Comment=Terminal chat UI for claude.ai free tier
Path=${HOME}
Exec=${ROOT_DIR}/scripts/launch-claude-free-tui.sh
Icon=${ROOT_DIR}/assets/claude-walkie.svg
Terminal=false
StartupNotify=true
Categories=Utility;
TUIEOF

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${HOME}/.local/share/applications" 2>/dev/null || true
fi

chmod +x "${TUI_DESKTOP_FILE}"

safe_copy "${TUI_DESKTOP_FILE}" "${TUI_DESKTOP_SHORTCUT}"
chmod +x "${TUI_DESKTOP_SHORTCUT}" 2>/dev/null || true
if command -v gio >/dev/null 2>&1; then
  gio set "${TUI_DESKTOP_SHORTCUT}" "metadata::trusted" true >/dev/null 2>&1 || true
fi

echo "  ${TUI_DESKTOP_FILE}"
if [[ -f "${TUI_DESKTOP_SHORTCUT}" ]]; then
  echo "  ${TUI_DESKTOP_SHORTCUT}"
fi
echo

# ── Collab terminal desktop entry ──────────────────────────────────────────
COLLAB_APP_NAME="walkie-collab"
COLLAB_DESKTOP_NAME="Walkie Collab"
COLLAB_DESKTOP_FILE="${HOME}/.local/share/applications/${COLLAB_APP_NAME}.desktop"
COLLAB_DESKTOP_SHORTCUT="${DESKTOP_DIR}/${COLLAB_APP_NAME}.desktop"

cat >"${COLLAB_DESKTOP_FILE}" <<COLLABEOF
[Desktop Entry]
Version=1.0
Type=Application
Name=${COLLAB_DESKTOP_NAME}
Comment=Open a two-hour local-model and Claude free-tier collab terminal
Path=${ROOT_DIR}
Exec=${ROOT_DIR}/scripts/launch-walkie-collab.sh
Icon=${ROOT_DIR}/assets/claude-walkie.svg
Terminal=false
StartupNotify=true
Categories=Utility;Science;Education;
COLLABEOF

chmod +x "${ROOT_DIR}/scripts/launch-walkie-collab.sh"
chmod +x "${COLLAB_DESKTOP_FILE}"

safe_copy "${COLLAB_DESKTOP_FILE}" "${COLLAB_DESKTOP_SHORTCUT}"
chmod +x "${COLLAB_DESKTOP_SHORTCUT}" 2>/dev/null || true
if command -v gio >/dev/null 2>&1; then
  gio set "${COLLAB_DESKTOP_SHORTCUT}" "metadata::trusted" true >/dev/null 2>&1 || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${HOME}/.local/share/applications" 2>/dev/null || true
fi

echo "  ${COLLAB_DESKTOP_FILE}"
if [[ -f "${COLLAB_DESKTOP_SHORTCUT}" ]]; then
  echo "  ${COLLAB_DESKTOP_SHORTCUT}"
fi
echo
echo "You can now click \"${DESKTOP_NAME}\", \"${TUI_DESKTOP_NAME}\", or \"${COLLAB_DESKTOP_NAME}\" from your app menu, or from Desktop."
