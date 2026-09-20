#!/usr/bin/env node
"use strict";
// Source-contract guards, NOT Android hardware/instrumentation tests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const src = fs.readFileSync(path.join(__dirname, "../android/src/com/vocalpure/app/MainActivity.java"), "utf8");
assert(src.includes("android.bluetooth.a2dp.profile.action.CONNECTION_STATE_CHANGED"));
assert(src.includes("android.bluetooth.profile.extra.STATE"));
assert(!src.includes("android.bluetooth.device.action.A2DP_CONNECTION_STATE"));
assert(src.includes("getDevices(AudioManager.GET_DEVICES_OUTPUTS)"));
assert(src.includes("AudioDeviceInfo.TYPE_BLUETOOTH_A2DP"));
assert(!src.includes("BluetoothProxyProxy"));
assert(!src.includes("a2dpProxy"));
assert(!/audioManager\.(setMode|setSpeakerphoneOn|startBluetoothSco)\(/.test(src));
assert(src.includes("if (isInitialStickyBroadcast()) return;"));
assert(src.includes("onNativeMediaAction('focus:transient')"));
assert(src.includes("if (!focusHeld) runJs(\"onNativeMediaAction('focus:loss')\")"));
console.log("Native audio source contracts passed (device behavior not validated).");
