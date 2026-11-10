#!/bin/sh
set -eu
# Инструменты остаются в ignored output; root на машине разработчика не нужен.
tools_dir=${REVIEW_TOOLS_DIR:-"${CI_PROJECT_DIR:-.}/output/ci-tools"}
mkdir -p "$tools_dir"
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo 'Нужна Linux/macOS среда для release tools' >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo 'Архитектура не поддерживается' >&2; exit 1 ;; esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
case "${1:-helm}" in
  helm)
    archive="helm-v4.3.0-$os-$arch.tar.gz"
    curl --fail --silent --show-error --location --connect-timeout 10 --max-time 90 --retry 2 --retry-delay 1 "https://get.helm.sh/$archive" -o "$work/$archive"
    curl --fail --silent --show-error --location --connect-timeout 10 --max-time 90 --retry 2 --retry-delay 1 "https://get.helm.sh/$archive.sha256sum" -o "$work/checksum"
    expected=$(cut -d ' ' -f 1 "$work/checksum")
    actual=$(openssl dgst -sha256 "$work/$archive" | awk '{print $NF}')
    test "$actual" = "$expected" || { echo 'Checksum Helm не совпадает' >&2; exit 1; }
    tar -xzf "$work/$archive" -C "$work"
    cp "$work/$os-$arch/helm" "$tools_dir/helm"
    chmod 0755 "$tools_dir/helm"
    ;;
  kubectl)
    url="https://dl.k8s.io/release/v1.37.1/bin/$os/$arch/kubectl"
    curl --fail --silent --show-error --location --connect-timeout 10 --max-time 90 --retry 2 --retry-delay 1 "$url" -o "$work/kubectl"
    curl --fail --silent --show-error --location --connect-timeout 10 --max-time 90 --retry 2 --retry-delay 1 "$url.sha256" -o "$work/checksum"
    expected=$(cat "$work/checksum")
    actual=$(openssl dgst -sha256 "$work/kubectl" | awk '{print $NF}')
    test "$actual" = "$expected" || { echo 'Checksum kubectl не совпадает' >&2; exit 1; }
    cp "$work/kubectl" "$tools_dir/kubectl"
    chmod 0755 "$tools_dir/kubectl"
    ;;
  *) echo 'Доступны helm или kubectl' >&2; exit 1 ;;
esac
