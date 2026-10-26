ismen real apk build nhi hota hai demo/mock API handler hai. ismein gradle build execute nhi hota fix it 

.gitHub/workflows/apk-build.yml


name: Build APK

on:
  workflow_dispatch:
    inputs:
      variant:
        description: "Build variant"
        type: choice
        options:
          - release
          - debug
        default: release
        required: true

  push:
    branches:
      - main
    paths-ignore:
      - "backend/**"
      - "admin/**"
      - "**.md"

permissions:
  contents: read

concurrency:
  group: apk-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    name: Build Android APK
    runs-on: ubuntu-latest
    timeout-minutes: 40

    env:
      ANDROID_HOME: /usr/local/lib/android/sdk
      ANDROID_SDK_ROOT: /usr/local/lib/android/sdk

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Java 17
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "17"

      # Do not use android-actions/setup-android@v3 here.
      # Configure the SDK directly to avoid its legacy "sdkmanager tools" call.
      - name: Locate Android SDK
        shell: bash
        run: |
          set -euo pipefail

          if [ ! -d "$ANDROID_HOME" ]; then
            echo "::error::Android SDK directory not found: $ANDROID_HOME"
            exit 1
          fi

          SDKMANAGER=$(find "$ANDROID_HOME/cmdline-tools" \
            -type f -path "*/bin/sdkmanager" 2>/dev/null \
            | sort -V | tail -n 1)

          if [ -z "$SDKMANAGER" ]; then
            echo "::error::Android sdkmanager was not found."
            find "$ANDROID_HOME" -maxdepth 4 -type f \
              -name sdkmanager 2>/dev/null || true
            exit 1
          fi

          echo "ANDROID_HOME=$ANDROID_HOME" >> "$GITHUB_ENV"
          echo "ANDROID_SDK_ROOT=$ANDROID_HOME" >> "$GITHUB_ENV"
          echo "$(dirname "$SDKMANAGER")" >> "$GITHUB_PATH"

          echo "SDK manager: $SDKMANAGER"
          "$SDKMANAGER" --version

      - name: Accept Android SDK licenses
        shell: bash
        run: |
          set -euo pipefail

          SDKMANAGER=$(find "$ANDROID_HOME/cmdline-tools" \
            -type f -path "*/bin/sdkmanager" 2>/dev/null \
            | sort -V | tail -n 1)

          if [ -z "$SDKMANAGER" ]; then
            echo "::error::sdkmanager not found."
            exit 1
          fi

          set +o pipefail
          yes | "$SDKMANAGER" --licenses
          LICENSE_STATUS=${PIPESTATUS[1]}
          set -o pipefail

          if [ "$LICENSE_STATUS" -ne 0 ]; then
            echo "::error::Unable to accept Android SDK licenses."
            exit 1
          fi

      - name: Install Android SDK packages
        shell: bash
        run: |
          set -euo pipefail

          SDKMANAGER=$(find "$ANDROID_HOME/cmdline-tools" \
            -type f -path "*/bin/sdkmanager" 2>/dev/null \
            | sort -V | tail -n 1)

          if [ -z "$SDKMANAGER" ]; then
            echo "::error::sdkmanager not found."
            exit 1
          fi

          "$SDKMANAGER" --install \
            "platform-tools" \
            "platforms;android-35" \
            "build-tools;35.0.0"

          test -d "$ANDROID_HOME/platforms/android-35"
          test -x "$ANDROID_HOME/build-tools/35.0.0/apksigner"

          echo "Android SDK packages installed successfully."

      - name: Set up Gradle
        uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: "8.9"

      - name: Validate Android project
        shell: bash
        run: |
          set -euo pipefail

          if [ ! -f "settings.gradle" ] && \
             [ ! -f "settings.gradle.kts" ]; then
            echo "::error::Project settings.gradle or settings.gradle.kts not found."
            exit 1
          fi

          if [ ! -f "app/build.gradle" ] && \
             [ ! -f "app/build.gradle.kts" ]; then
            echo "::error::app/build.gradle or app/build.gradle.kts not found."
            exit 1
          fi

          echo "Android project structure verified."

      - name: Prepare release signing
        if: ${{ inputs.variant != 'debug' }}
        env:
          KEYSTORE_BASE64: ${{ secrets.KEYSTORE_BASE64 }}
          STORE_PASSWORD: ${{ secrets.STORE_PASSWORD }}
          KEY_ALIAS: ${{ secrets.KEY_ALIAS }}
          KEY_PASSWORD: ${{ secrets.KEY_PASSWORD }}
        shell: bash
        run: |
          set -euo pipefail

          if [ -z "$KEYSTORE_BASE64" ]; then
            echo "No external keystore configured."
            echo "The Gradle project must provide its own release signing configuration."
            exit 0
          fi

          if [ -z "$STORE_PASSWORD" ] || \
             [ -z "$KEY_ALIAS" ] || \
             [ -z "$KEY_PASSWORD" ]; then
            echo "::error::Release signing secrets are incomplete."
            exit 1
          fi

          printf '%s' "$KEYSTORE_BASE64" | base64 --decode > app-keystore.jks

          if [ ! -s app-keystore.jks ]; then
            echo "::error::Decoded keystore is empty."
            exit 1
          fi

          python3 - <<'PY'
          import os

          values = {
              "storeFile": "app-keystore.jks",
              "storePassword": os.environ["STORE_PASSWORD"],
              "keyAlias": os.environ["KEY_ALIAS"],
              "keyPassword": os.environ["KEY_PASSWORD"],
          }

          with open("keystore.properties", "w", encoding="utf-8") as f:
              for key, value in values.items():
                  escaped = value.replace("\\", "\\\\").replace(":", "\\:")
                  f.write(f"{key}={escaped}\n")
          PY

          echo "Release signing configuration prepared."

      - name: Build APK
        id: build
        env:
          VARIANT: ${{ inputs.variant || 'release' }}
        shell: bash
        run: |
          set -euo pipefail

          case "$VARIANT" in
            debug)
              gradle assembleDebug --no-daemon --console=plain
              ;;
            release)
              gradle assembleRelease --no-daemon --console=plain
              ;;
            *)
              echo "::error::Unsupported build variant: $VARIANT"
              exit 1
              ;;
          esac

      - name: Locate APK
        id: apk
        env:
          VARIANT: ${{ inputs.variant || 'release' }}
        shell: bash
        run: |
          set -euo pipefail

          APK_DIR="app/build/outputs/apk/$VARIANT"

          if [ ! -d "$APK_DIR" ]; then
            echo "::error::APK output directory not found: $APK_DIR"
            find app/build/outputs -type f 2>/dev/null || true
            exit 1
          fi

          APK=$(find "$APK_DIR" -type f -name "*.apk" \
            ! -name "*-unsigned.apk" | sort | head -n 1)

          if [ -z "$APK" ]; then
            echo "::error::No signed APK found."
            find "$APK_DIR" -type f 2>/dev/null || true
            exit 1
          fi

          echo "path=$APK" >> "$GITHUB_OUTPUT"
          echo "sha=$(sha256sum "$APK" | cut -d' ' -f1)" >> "$GITHUB_OUTPUT"
          echo "size=$(stat -c%s "$APK")" >> "$GITHUB_OUTPUT"

          echo "APK: $APK"

      - name: Verify APK signature
        env:
          APK_PATH: ${{ steps.apk.outputs.path }}
        shell: bash
        run: |
          set -euo pipefail

          APKSIGNER="$ANDROID_HOME/build-tools/35.0.0/apksigner"

          if [ ! -x "$APKSIGNER" ]; then
            echo "::error::apksigner not found."
            exit 1
          fi

          "$APKSIGNER" verify --verbose --print-certs "$APK_PATH"

      - name: Upload APK artifact
        uses: actions/upload-artifact@v4
        with:
          name: DESI-VIDEOS-APK-${{ inputs.variant || 'release' }}
          path: ${{ steps.apk.outputs.path }}
          if-no-files-found: error
          retention-days: 14

      - name: Build summary
        if: success()
        env:
          VARIANT: ${{ inputs.variant || 'release' }}
          APK_SIZE: ${{ steps.apk.outputs.size }}
          APK_SHA: ${{ steps.apk.outputs.sha }}
        shell: bash
        run: |
          {
            echo "## APK Build Successful"
            echo ""
            echo "- Variant: $VARIANT"
            echo "- Size: $APK_SIZE bytes"
            echo "- SHA-256: \`$APK_SHA\`"
            echo ""
            echo "Download the APK from the workflow run's Artifacts section."
          } >> "$GITHUB_STEP_SUMMARY"


app/build.gradle.kts

import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Load builder.properties from the project root.
val builderProps = Properties().apply {
    val file = rootProject.file("builder.properties")
    if (file.isFile) {
        file.inputStream().use { load(it) }
    }
}

// Load keystore.properties from the project root.
val keystoreProps = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.isFile) {
        file.inputStream().use { load(it) }
    }
}

// Builder overrides.
val appIdOverride: String? =
    builderProps.getProperty("appId")
        ?.trim()
        ?.takeIf { it.isNotEmpty() }

val versionCodeOverride: Int =
    builderProps.getProperty("versionCode")
        ?.toIntOrNull()
        ?.takeIf { it > 0 }
        ?: 6

val versionNameOverride: String =
    builderProps.getProperty("versionName")
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?: "4.4"

// Release signing properties.
val releaseStorePath: String? =
    keystoreProps.getProperty("storeFile")
        ?.trim()
        ?.takeIf { it.isNotEmpty() }

val hasReleaseKeystore = releaseStorePath != null

android {
    // Keep namespace stable for R references and application code.
    namespace = "com.screenlink.remote"

    compileSdk = 35

    defaultConfig {
        applicationId = appIdOverride ?: "com.screenlink.remote"

        minSdk = 23
        targetSdk = 35

        versionCode = versionCodeOverride
        versionName = versionNameOverride

        resourceConfigurations += listOf("en")

        vectorDrawables {
            useSupportLibrary = false
        }
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = rootProject.file(releaseStorePath!!)

                storePassword =
                    keystoreProps.getProperty("storePassword")

                keyAlias =
                    keystoreProps.getProperty("keyAlias")

                keyPassword =
                    keystoreProps.getProperty("keyPassword")

                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            isDebuggable = true
        }

        release {
            isMinifyEnabled = true
            isShrinkResources = true

            proguardFiles(
                getDefaultProguardFile(
                    "proguard-android-optimize.txt"
                ),
                "proguard-rules.pro"
            )

            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17

        isCoreLibraryDesugaringEnabled = false
    }

    kotlinOptions {
        jvmTarget = "17"

        freeCompilerArgs += listOf(
            "-Xjvm-default=all",
            "-opt-in=kotlin.RequiresOptIn"
        )
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "/META-INF/DEPENDENCIES",
                "/META-INF/LICENSE*",
                "/META-INF/*.kotlin_module"
            )
        }
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation(
        "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0"
    )

    implementation(
        "org.jetbrains.kotlin:kotlin-stdlib:2.0.21"
    )
}


admin/index.html

