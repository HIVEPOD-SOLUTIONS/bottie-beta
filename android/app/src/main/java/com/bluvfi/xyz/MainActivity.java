package com.bluvfi.xyz;

import android.webkit.PermissionRequest;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onStart() {
        super.onStart();
        // Override WebView permission requests to ensure audio capture works.
        // Capacitor's BridgeWebChromeClient may not properly forward the Android
        // OS-level RECORD_AUDIO grant to the WebView context on all devices/versions.
        // Android OS still enforces RECORD_AUDIO independently, so granting all
        // WebView permission requests here is safe.
        try {
            getBridge().getWebView().setWebChromeClient(
                new BridgeWebChromeClient(getBridge()) {
                    @Override
                    public void onPermissionRequest(final PermissionRequest request) {
                        request.grant(request.getResources());
                    }
                }
            );
        } catch (Exception ignored) {}
    }
}
