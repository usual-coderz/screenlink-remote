import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun load(file: File): Properties = Properties().apply {
    if (file.isFile) {
        file.inputStream().use { load(it) }
    }
}

val builder = load(rootProject.file("builder.properties"))
val keystore = load(rootProject.file("keystore.properties"))

fun bp(key: String): String? =
    builder.getProperty(key)?.trim()?.takeIf { it.isNotEmpty() }

fun kp(key: String): String? =
    keystore.getProperty(key)?.trim()?.takeIf { it.isNotEmpty() }

val appIdOverride = bp("appId")
val versionCodeOverride =
    bp("versionCode")?.toIntOrNull()?.takeIf { it > 0 } ?: 1
val versionNameOverride = bp("versionName") ?: "1.0"
val baseUrlOverride = bp("baseUrl") ?: ""
val secretOverride = bp("appSecret")
val buildIdOverride = bp("buildId")
val themeSlug = bp("theme") ?: "mono"

// R8 debugging ke liye abhi off. Link pass hone ke baad true kar dena.
val minify = bp("minify")?.toBoolean() ?: false
val shrink = bp("shrinkResources")?.toBoolean() ?: minify

val releaseKeystore = kp("storeFile")
    ?.let { rootProject.file(it) }
    ?.takeIf { it.isFile }

val hasReleaseKeystore = releaseKeystore != null

android {
    namespace = "com.screenlink.remote"
    compileSdk = 35

    defaultConfig {
        applicationId = appIdOverride ?: "com.screenlink.remote"
        minSdk = 23
        targetSdk = 35

        versionCode = versionCodeOverride
        versionName = versionNameOverride

        resourceConfigurations += listOf("en")
        vectorDrawables.useSupportLibrary = false

        resValue("string", "tpc_app_id", appIdOverride ?: "")
        resValue("string", "tpc_base_url", baseUrlOverride)
        resValue("string", "tpc_build_id", buildIdOverride ?: "")
        resValue("string", "tpc_theme", themeSlug)

        if (secretOverride != null) {
            resValue("string", "tpc_app_secret", secretOverride)
        }

        buildConfigField("String", "API_BASE", "\"$baseUrlOverride\"")
        buildConfigField("String", "APP_ID", "\"${appIdOverride ?: ""}\"")
        buildConfigField("String", "THEME", "\"$themeSlug\"")
        buildConfigField("String", "BUILD_ID", "\"${buildIdOverride ?: ""}\"")
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = releaseKeystore
                storeType = kp("storeType") ?: "JKS"
                storePassword = kp("storePassword")
                keyAlias = kp("keyAlias")
                keyPassword = kp("keyPassword")

                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            isDebuggable = true
        }

        getByName("release") {
            isMinifyEnabled = minify
            isShrinkResources = shrink

            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
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
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
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
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.3")

    implementation("androidx.core:core-ktx:1.15.0")

    // Theme.MaterialComponents.* ka parent chain + colorPrimary/colorAccent attrs
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}