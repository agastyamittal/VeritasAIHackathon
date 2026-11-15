package com.aeroform.app;

import android.app.Activity;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ActivityInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.Surface;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.Locale;

/** Offline native host. Only packaged content can call the sensor/fullscreen bridge. */
public final class MainActivity extends Activity implements SensorEventListener {
  private static final String HOST = "appassets.androidplatform.net";
  // Shared cloud models (Supabase Storage). Only HTTPS requests to this host reach the network.
  private static final String CLOUD_HOST = "hhbjrfngfsibceohcgco.supabase.co";
  private WebView web;
  private SensorManager sensors;
  private Sensor rotation;
  private Sensor accelerometer;
  // Step detection runs in JS: samples of |a| - 9.81 are sent in batches every 100 ms.
  private final StringBuilder motionBatch = new StringBuilder();
  private long motionFlushAt;
  private boolean vr;
  private long lastSample;
  private ValueCallback<Uri[]> fileCallback;
  // Camera (hand tracking) and microphone (clap) requests from the page. Entering VR asks for both at once,
  // so they are queued and Android is asked one dialog at a time.
  private final ArrayList<PermissionRequest> mediaRequests = new ArrayList<>();
  private boolean askingPermissions;
  // System bar sizes in CSS pixels (top, right, bottom, left), passed to the page as --native-* variables.
  private int[] insets = {0, 0, 0, 0};

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    sensors = (SensorManager) getSystemService(SENSOR_SERVICE);
    rotation = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
    if (rotation == null) rotation = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
    accelerometer = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
    web = new WebView(this);
    web.setBackgroundColor(0xff0b0b0b);
    // The page draws edge to edge and keeps its own controls clear of the status and navigation bars.
    web.setOnApplyWindowInsetsListener((view, windowInsets) -> {
      float density = getResources().getDisplayMetrics().density;
      insets = vr ? new int[]{0, 0, 0, 0} : new int[]{
        Math.round(windowInsets.getSystemWindowInsetTop() / density), Math.round(windowInsets.getSystemWindowInsetRight() / density),
        Math.round(windowInsets.getSystemWindowInsetBottom() / density), Math.round(windowInsets.getSystemWindowInsetLeft() / density)};
      view.setPadding(0, 0, 0, 0);
      pushInsets();
      return windowInsets;
    });
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(true);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.addJavascriptInterface(new NativeBridge(), "AeroformNative");
    web.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if ("https".equals(uri.getScheme()) && CLOUD_HOST.equals(uri.getHost())) return super.shouldInterceptRequest(view, request);
        if (!"https".equals(uri.getScheme()) || !HOST.equals(uri.getHost())) return missing();
        String path = uri.getPath();
        if (path == null || "/".equals(path)) path = "/index.html";
        if (path.contains("..") || path.contains("\\")) return missing();
        try {
          return new WebResourceResponse(mime(path), "UTF-8", 200, "OK", Collections.singletonMap("Cache-Control", "no-store"), getAssets().open("www" + path));
        } catch (IOException error) { return missing(); }
      }
      @Override public void onPageFinished(WebView view, String url) { pushInsets(); }
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return !HOST.equals(request.getUrl().getHost()) || !"https".equals(request.getUrl().getScheme());
      }
    });
    web.setWebChromeClient(new WebChromeClient() {
      // Hand tracking (camera) and clap to recenter (microphone): grant packaged pages these two only,
      // asking Android for the permission first if needed.
      @Override public void onPermissionRequest(final PermissionRequest request) {
        boolean packaged = request.getOrigin() != null && HOST.equals(request.getOrigin().getHost());
        if (!packaged || wanted(request).length == 0) { request.deny(); return; }
        mediaRequests.add(request);
        settleMediaRequests(null);
      }
      @Override public void onPermissionRequestCanceled(PermissionRequest request) {
        mediaRequests.remove(request);
      }
      @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        try { startActivityForResult(intent, 41); }
        catch (RuntimeException error) { fileCallback.onReceiveValue(null); fileCallback = null; }
        return true;
      }
    });
    setContentView(web);
    web.loadUrl("https://" + HOST + "/index.html");
  }
  private void pushInsets() {
    if (web == null) return;
    web.evaluateJavascript(String.format(Locale.US, "(function(s){s.setProperty('--native-top','%dpx');s.setProperty('--native-right','%dpx');s.setProperty('--native-bottom','%dpx');s.setProperty('--native-left','%dpx');})(document.documentElement.style)", insets[0], insets[1], insets[2], insets[3]), null);
  }
  private static String mime(String path) {
    if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
    if (path.endsWith(".wasm")) return "application/wasm";
    if (path.endsWith(".task") || path.endsWith(".stl") || path.endsWith(".obj")) return "application/octet-stream";
    if (path.endsWith(".css")) return "text/css";
    if (path.endsWith(".svg")) return "image/svg+xml";
    if (path.endsWith(".webmanifest")) return "application/manifest+json";
    if (path.endsWith(".json")) return "application/json";
    return "text/html";
  }
  private static WebResourceResponse missing() {
    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
  }
  public final class NativeBridge {
    @JavascriptInterface public void setVrMode(final boolean enabled) {
      runOnUiThread(() -> {
        vr = enabled;
        int display = getWindowManager().getDefaultDisplay().getRotation();
        // Keep the chosen landscape direction stable while the user turns their head.
        int landscape = display == Surface.ROTATION_270 ? ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
        setRequestedOrientation(enabled ? landscape : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        if (enabled) {
          getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
          if (rotation != null) sensors.registerListener(MainActivity.this, rotation, SensorManager.SENSOR_DELAY_GAME);
          if (accelerometer != null) sensors.registerListener(MainActivity.this, accelerometer, SensorManager.SENSOR_DELAY_GAME);
        } else {
          getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
          sensors.unregisterListener(MainActivity.this);
        }
        applyFullscreen();
      });
    }
  }
  private void applyFullscreen() {
    getWindow().getDecorView().setSystemUiVisibility(vr ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE : View.SYSTEM_UI_FLAG_VISIBLE);
    web.requestApplyInsets();
  }
  @Override public void onWindowFocusChanged(boolean focus) { super.onWindowFocusChanged(focus); if (focus) applyFullscreen(); }
  @Override protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request,result,data);
    if (request == 41 && fileCallback != null) {
      fileCallback.onReceiveValue(result == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null);
      fileCallback = null;
    }
  }
  @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(request, permissions, results);
    if (request != 42) return;
    askingPermissions = false;
    ArrayList<String> refused = new ArrayList<>();
    for (int i = 0; i < permissions.length && i < results.length; i++) if (results[i] != PackageManager.PERMISSION_GRANTED) refused.add(permissions[i]);
    settleMediaRequests(refused);
  }
  // Media resources this app grants: camera and microphone only.
  private static String[] wanted(PermissionRequest request) {
    ArrayList<String> out = new ArrayList<>();
    for (String resource : request.getResources()) {
      if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) || PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) out.add(resource);
    }
    return out.toArray(new String[0]);
  }
  private static String permissionFor(String resource) {
    return PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) ? Manifest.permission.CAMERA : Manifest.permission.RECORD_AUDIO;
  }
  // Grants every queued request whose permissions Android has given; a request that needs a permission the
  // user just refused gets what was granted (or is denied); anything still missing is asked for in one dialog.
  private void settleMediaRequests(ArrayList<String> refused) {
    ArrayList<String> missing = new ArrayList<>();
    for (Iterator<PermissionRequest> it = mediaRequests.iterator(); it.hasNext();) {
      PermissionRequest request = it.next();
      ArrayList<String> granted = new ArrayList<>();
      boolean waiting = false, wasRefused = false;
      for (String resource : wanted(request)) {
        String permission = permissionFor(resource);
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
        else if (refused != null && refused.contains(permission)) wasRefused = true;
        else { waiting = true; if (!missing.contains(permission)) missing.add(permission); }
      }
      if (waiting && !wasRefused) continue;
      if (granted.isEmpty()) request.deny(); else request.grant(granted.toArray(new String[0]));
      it.remove();
    }
    if (!missing.isEmpty() && !askingPermissions) {
      askingPermissions = true;
      requestPermissions(missing.toArray(new String[0]), 42);
    }
  }
  @Override public void onSensorChanged(SensorEvent event) {
    if (!vr) return;
    if (event.sensor.getType() == Sensor.TYPE_ACCELEROMETER) {
      long ms = event.timestamp / 1000000L;
      double value = Math.sqrt(event.values[0] * event.values[0] + event.values[1] * event.values[1] + event.values[2] * event.values[2]) - 9.81;
      motionBatch.append(motionBatch.length() == 0 ? "" : ",").append('[').append(ms).append(',').append(String.format(Locale.US, "%.3f", value)).append(']');
      if (ms >= motionFlushAt) {
        motionFlushAt = ms + 100;
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('aeroform-motion',{detail:[" + motionBatch + "]}))", null);
        motionBatch.setLength(0);
      }
      return;
    }
    if (event.timestamp - lastSample < 16000000) return;
    lastSample = event.timestamp;
    float[] q = new float[4]; SensorManager.getQuaternionFromVector(q,event.values);
    int display = getWindowManager().getDefaultDisplay().getRotation();
    double angle = display == Surface.ROTATION_90 ? -Math.PI/2 : display == Surface.ROTATION_270 ? -3*Math.PI/2 : display == Surface.ROTATION_180 ? -Math.PI : 0;
    double s = Math.sin(angle/2), c = Math.cos(angle/2);
    // Quaternion order is x,y,z,w. Rotate device axes into the displayed landscape axes.
    String values = String.format(Locale.US,"[%f,%f,%f,%f]",q[1]*c+q[2]*s,q[2]*c-q[1]*s,q[3]*c+q[0]*s,q[0]*c-q[3]*s);
    web.evaluateJavascript("window.dispatchEvent(new CustomEvent('aeroform-orientation',{detail:"+values+"}))",null);
  }
  @Override public void onAccuracyChanged(Sensor sensor,int accuracy) {}
  @Override protected void onPause() { super.onPause(); sensors.unregisterListener(this); web.onPause(); }
  @Override protected void onResume() {
    super.onResume(); if (web != null) web.onResume();
    if (vr && rotation != null) sensors.registerListener(this, rotation, SensorManager.SENSOR_DELAY_GAME);
    if (vr && accelerometer != null) sensors.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_GAME);
  }
  @Override public void onBackPressed() {
    web.evaluateJavascript("(function(){var handled=document.body.classList.contains('stereo-mode')||document.querySelector('#help-modal').open||document.querySelector('#conditions-modal').open||document.querySelector('#analysis-modal').open||document.querySelector('#lens-modal').open||document.querySelector('#sidebar').classList.contains('open');window.dispatchEvent(new Event('aeroform-back'));return handled;})()", result -> { if (!"true".equals(result)) finish(); });
  }
  @Override protected void onDestroy() { sensors.unregisterListener(this); if(fileCallback!=null)fileCallback.onReceiveValue(null); web.destroy(); super.onDestroy(); }
}
