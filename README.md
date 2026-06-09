# PricePilot AU Extension

This folder contains the Chrome extension for PricePilot AU.

## Current setup

- The extension now defaults to the live backend at `https://robust-patience-production-8176.up.railway.app`.
- You can still override the backend in the popup if you want to test against a different server.
- If no custom backend is saved, the extension uses the live Railway service automatically.

## Load unpacked

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `extension` folder.

## Quick test

1. Open a product page on a supported site.
2. Open the PricePilot popup.
3. Confirm the backend status shows as connected.
4. Use the page panel to compare prices.

## Files

- `background.js` - backend fetch logic, AI hooks, and alert tracking.
- `content.js` - page extraction and panel UI.
- `popup.html` - settings UI for backend URL and AI key.
- `panel.css` - injected panel styles.
- `manifest.json` - extension permissions and entry points.