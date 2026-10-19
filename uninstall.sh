#!/usr/bin/env bash
# 卸载 dsh-computer-use 0.4.0（只移除 install.sh 写入的内容）
# 用法: ./uninstall.sh [--dry-run] [--profile desktop]
set -euo pipefail

DRY_RUN=0
PROFILE=desktop
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --profile) shift; PROFILE="${1:-desktop}" ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
NM_DIR="$DSH_HOME/profiles/$PROFILE/node_modules"
PATCH="$DSH_HOME/cordis.patch.yml"
MARK_BEGIN='# >>> dsh-computer-use (HOME layer preset; managed by install.sh)'
MARK_END='# <<< dsh-computer-use'

echo "== dsh-computer-use 0.4.0 uninstall =="
echo "  DSH_HOME : $DSH_HOME"
echo "  profile  : $PROFILE"

LINK="$NM_DIR/dsh-computer-use"
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] remove $LINK"
  echo "  [dry-run] remove HOME patch block"
else
  if [ -e "$LINK" ] || [ -L "$LINK" ]; then
    rm -rf "$LINK"
    echo "  [ok] 已移除插件链接"
  else
    echo "  [ok] 插件链接不存在（跳过）"
  fi

  if [ -f "$PATCH" ] && grep -qF "$MARK_BEGIN" "$PATCH"; then
    TMP="$PATCH.tmp.$$"
    awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
      $0 == b {skip=1; next}
      $0 == e {skip=0; next}
      !skip {print}
    ' "$PATCH" > "$TMP"
    mv "$TMP" "$PATCH"
    echo "  [ok] 已移除 HOME patch 中的 preset-computer-use 区块"
  else
    echo "  [ok] HOME patch 无 dsh-computer-use 区块（跳过）"
  fi
fi
echo "== 完成。重启 DeepSeek Harness 桌面端后生效 =="
