#!/usr/bin/env bash
set -euo pipefail

PUBLIC_KEY="${1:-}"
if [[ -z "$PUBLIC_KEY" ]]; then
  echo "Usage: $0 'ssh-ed25519 AAAA... siku-github-release'" >&2
  exit 64
fi

id siku-release >/dev/null 2>&1 || useradd --create-home --shell /bin/bash siku-release
install -d -m 700 -o siku-release -g siku-release /home/siku-release/.ssh
printf '%s\n' "$PUBLIC_KEY" > /home/siku-release/.ssh/authorized_keys
chown siku-release:siku-release /home/siku-release/.ssh/authorized_keys
chmod 600 /home/siku-release/.ssh/authorized_keys

install -d -m 750 -o siku-release -g siku-release /opt/siku/backend/app-release
install -d -m 750 -o siku-release -g siku-release /opt/siku/backend/test-releases

cat > /usr/local/bin/siku-publish-release <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
TYPE="${1:-}"
SOURCE="${2:-}"
[[ "$SOURCE" == /tmp/siku-release-* ]] || { echo "invalid source" >&2; exit 64; }
[[ -d "$SOURCE" ]] || { echo "source missing" >&2; exit 66; }
cd "$SOURCE"
sha256sum -c SHA256SUMS
APK=$(awk '{print $2}' SHA256SUMS | sed 's#^\*##')
[[ "$APK" =~ ^siku-[0-9]+\.apk$ ]] || { echo "invalid apk" >&2; exit 65; }

if [[ "$TYPE" == "production" ]]; then
  TARGET=/opt/siku/backend/app-release
  install -m 640 "$APK" "$TARGET/$APK.tmp"
  mv "$TARGET/$APK.tmp" "$TARGET/$APK"
  install -m 640 version.json "$TARGET/version.json.tmp"
  mv "$TARGET/version.json.tmp" "$TARGET/version.json"
elif [[ "$TYPE" == "ip_test" ]]; then
  TARGET=/opt/siku/backend/test-releases
  install -m 640 "$APK" "$TARGET/$APK.tmp"
  mv "$TARGET/$APK.tmp" "$TARGET/$APK"
  install -m 640 version.json "$TARGET/version-${APK%.apk}.json"
else
  echo "invalid release type" >&2
  exit 64
fi

find "$TARGET" -maxdepth 1 -name 'siku-*.apk' -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d' ' -f2- | xargs -r rm -f
rm -rf "$SOURCE"
SCRIPT
chmod 755 /usr/local/bin/siku-publish-release

echo "siku-release deploy user installed"
