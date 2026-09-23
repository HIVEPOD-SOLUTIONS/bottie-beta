package com.bluvfi.xyz;

import android.os.Bundle;
import android.webkit.PermissionRequest;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Safety net: directly grant WebView audio/video capture requests.
        // Capacitor's default handler also requires MODIFY_AUDIO_SETTINGS in the
        // manifest; this override skips that launcher path entirely.
        // Registered here (in onCreate) so registerForActivityResult lifecycle
        // constraints are satisfied.
        getBridge().getWebView().setWebChromeClient(
            new BridgeWebChromeClient(getBridge()) {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    request.grant(request.getResources());
                }
            }
        );
    }
}
