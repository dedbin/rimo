#!/usr/bin/env python3
import requests
import base64
import os

API_URL = "http://localhost:3000/api/generate-cover"  # Adjust if needed
OUTPUT_DIR = "covers"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Updated list of generator names matching your TypeScript `generators` array
generator_names = [
    "gradient",
    "geometric",
    "lineArt",
    "watercolor",
    "pixel",
    "ornament",
    "biomorphic",
    "cosmic",
    "doodle",
    "stripe",
]

def test_each_cover():
    for name in generator_names:
        try:
            # request specific generator by name
            resp = requests.post(API_URL, json={"name": name})
            resp.raise_for_status()
            data = resp.json()

            prefix = "data:image/svg+xml;base64,"
            if not data.get("imageUrl", "").startswith(prefix):
                print(f"[{name}] Unexpected URL format: {data.get('imageUrl')}")
                continue

            svg_bytes = base64.b64decode(data["imageUrl"][len(prefix):])
            filename = os.path.join(OUTPUT_DIR, f"{name}_{data['id']}.svg")
            with open(filename, "wb") as f:
                f.write(svg_bytes)

            print(f"[{name}] Saved -> {filename}")
        except Exception as e:
            print(f"[{name}] Error: {e}")

if __name__ == "__main__":
    test_each_cover()
