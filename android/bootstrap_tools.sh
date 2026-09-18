#!/usr/bin/env bash
# One-time toolchain bootstrap for build_apk.py (no Android SDK needed).
# Downloads: aapt2 binary (npm), JDK8 tools.jar (npm), android.jar (GitHub),
# and compiles AOSP dx from source using javac8.
set -euo pipefail
TOOLS=${VP_TOOLS:-/opt/build/tools}
mkdir -p "$TOOLS"
cd "$TOOLS"

# 1. aapt2 (linux x64) from the aaptjs3 npm package
if [ ! -x aapt2 ]; then
  curl -sL https://registry.npmjs.org/aaptjs3/-/aaptjs3-2.0.2.tgz -o aaptjs3.tgz
  tar xzf aaptjs3.tgz package/bin/x64/linux/aapt2
  mv package/bin/x64/linux/aapt2 aapt2 && chmod +x aapt2
  rm -rf package aaptjs3.tgz
fi

# 2. JDK8 tools.jar (contains com.sun.tools.javac.Main) — run on any JRE 8+
if [ ! -f tools.jar ]; then
  curl -sL https://registry.npmjs.org/dataslope-tools-jar/-/dataslope-tools-jar-1.0.0.tgz -o tj.tgz
  tar xzf tj.tgz package/tools.jar && mv package/tools.jar tools.jar
  rm -rf package tj.tgz
fi

# 3. android.jar (API 25 platform stubs) from the Sable/android-platforms mirror
if [ ! -f android.jar ]; then
  gh api repos/Sable/android-platforms/contents/android-25/android.jar \
    -H "Accept: application/vnd.github.raw" > android.jar
fi

# 4. dx: compile AOSP dx sources (vendored in CodingGay/BlackObfuscator) with javac8
if [ ! -d dxclasses ]; then
  curl -sL https://codeload.github.com/CodingGay/BlackObfuscator/tar.gz/HEAD -o bo.tgz
  tar xzf bo.tgz
  SRC=$(find . -maxdepth 2 -type d -name BlackObfuscator-* | head -1)/dx/src/main/java
  JAVA=${VP_JAVA:?set VP_JAVA to a java binary}
  TOOLSJAR="$PWD/tools.jar"
  mkdir -p dxclasses
  # NOTE: -bootclasspath points at android.jar so javac8 finds java.lang
  # when tools.jar runs on a modern JRE (9+) that has no rt.jar.
  $JAVA -Dsun.boot.class.path= -cp "$TOOLSJAR" com.sun.tools.javac.Main \
        -encoding UTF-8 -bootclasspath "$PWD/android.jar" \
        -source 8 -target 8 -nowarn -d dxclasses \
        $(find "$SRC" -name '*.java')
  rm -rf bo.tgz BlackObfuscator-*
fi

echo "toolchain ready in $TOOLS"
