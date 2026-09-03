# Android patches to apply after `cap add android`

After running `npx cap add android`, apply these changes:

## 1. AndroidManifest.xml — permissions

File: `android/app/src/main/AndroidManifest.xml`

Add inside `<manifest>` (before `<application>`):

```xml
<!-- Required: Internet for API calls, Privy auth, wallet ops -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

<!-- Voice input -->
<uses-permission android:name="android.permission.RECORD_AUDIO" />

<!-- Optional: vibration for haptic feedback -->
<uses-permission android:name="android.permission.VIBRATE" />
```

Add the deep-link intent filter inside `<activity>` (for Privy OAuth redirect):

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https"
          android:host="your-domain.vercel.app"
          android:pathPrefix="/api/auth/callback" />
</intent-filter>

<!-- Custom scheme for Privy redirect -->
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="com.bluvfi.app" />
</intent-filter>
```

## 2. network_security_config.xml (dev only)

File: `android/app/src/main/res/xml/network_security_config.xml` (create if missing)

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Allow cleartext only to localhost in debug builds -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">10.0.2.2</domain>
        <domain includeSubdomains="false">localhost</domain>
    </domain-config>
</network-security-config>
```

Reference it in `AndroidManifest.xml` on the `<application>` tag:
```xml
android:networkSecurityConfig="@xml/network_security_config"
```

## 3. strings.xml — app label & deep-link scheme

File: `android/app/src/main/res/values/strings.xml`

```xml
<string name="app_name">Bluvfi</string>
<string name="custom_url_scheme">com.bluvfi.app</string>
<string name="title_activity_main">Bluvfi</string>
```

## 4. Build signing (release)

For release builds, create `android/keystore.properties`:
```
storePassword=YOUR_KEYSTORE_PASSWORD
keyPassword=YOUR_KEY_PASSWORD
keyAlias=bluvfi
storeFile=bluvfi-release.jks
```

Generate the keystore:
```bash
keytool -genkey -v -keystore android/bluvfi-release.jks \
  -alias bluvfi -keyalg RSA -keysize 2048 -validity 10000
```
