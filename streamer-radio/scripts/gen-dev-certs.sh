#!/usr/bin/env bash
set -euo pipefail

# Generates a WebTransport-compatible self-signed ECDSA P-256 certificate
# Valid for <= 14 days (strictly required by W3C WebTransport serverCertificateHashes).

OUT_DIR="${1:-./certs}"
mkdir -p "$OUT_DIR"

KEY_FILE="$OUT_DIR/key.pem"
CERT_FILE="$OUT_DIR/cert.pem"
HASH_FILE="$OUT_DIR/cert-hash.hex"
HASH_B64_FILE="$OUT_DIR/cert-hash.base64"

echo "Generating ECDSA P-256 private key and 13-day self-signed certificate..."

openssl ecparam -name prime256v1 -genkey -noout -out "$KEY_FILE"

openssl req -new -x509 \
  -key "$KEY_FILE" \
  -out "$CERT_FILE" \
  -days 13 \
  -subj "/CN=localhost/O=Streamer Radio Dev" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"

# Extract DER SHA-256 fingerprint for browser WebTransport({ serverCertificateHashes })
openssl x509 -in "$CERT_FILE" -outform der | openssl dgst -sha256 -binary > "$OUT_DIR/cert.sha256.bin"
xxd -p -c 64 "$OUT_DIR/cert.sha256.bin" > "$HASH_FILE"
base64 < "$OUT_DIR/cert.sha256.bin" | tr -d '\n' > "$HASH_B64_FILE"
rm -f "$OUT_DIR/cert.sha256.bin"

chmod 600 "$KEY_FILE"
chmod 644 "$CERT_FILE" "$HASH_FILE" "$HASH_B64_FILE"

echo ""
echo "Certificates generated in $OUT_DIR:"
echo "  Key:           $KEY_FILE"
echo "  Cert:          $CERT_FILE"
echo "  SHA-256 (hex): $(cat "$HASH_FILE")"
echo "  SHA-256 (b64): $(cat "$HASH_B64_FILE")"
echo ""
echo "Note: W3C WebTransport requires self-signed certs to use ECDSA P-256 and expire in <= 14 days."
echo "Re-run this script before the 13-day window expires, or use Let's Encrypt in production."
