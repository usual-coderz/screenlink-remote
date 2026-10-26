import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/* ------------------------------------------------------------------ *
 *  per-build overrides — backend.apk_builder.worker likhta hai
 * ------------------------------------------------------------------ */

fun loadProps(file: File): Properties = Properties().apply {
    if (file.isFile) file.inputStream().use { load(it) }
}

val builderProps = loadProps(rootProject.file("builder.properties"))
val keystoreProps = loadProps(rootProject.file("keystore.properties"))

fun bp(key: String): String? =
    builderProps.getProperty(key)?.trim()?.takeIf { it.isNotEmpty() }

fun kp(key: String): String? =
    keystoreProps.getProperty(key)?.trim()?.takeIf { it.isNotEmpty() }

val appIdOverride = bp("appId")
val appNameOverride = bp("appName")
val versionCodeOverride = bp("versionCode")?.toIntOrNull()?.takeIf { it > 0 } ?: 1
val versionNameOverride = bp("versionName") ?: "1.0"
val baseUrlOverride = bp("baseUrl") ?: ""
val secretOverride = bp("appSecret")
val buildIdOverride = bp("buildId")

val minify = bp("minify")?.toBoolean() ?: true
val shrink = bp("shrinkResources")?.toBoolean() ?: minify

// keystore actually exist karta hai? warna release silently debug se sign ho jata hai
val releaseKeystoreFile = kp("storeFile")
    ?.let { rootProject.file(it) }
    ?.takeIf { it.isFile }

val hasReleaseKeystore = releaseKeystoreFile != null

android {
    // namespace FIXED rehta hai — R references / app code kabhi nahi tootega.
    // Sirf applicationId per-app badalta hai.
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

        // ---- runtime config APK ke andar embed ----
        resValue("string", "tpc_app_id", appIdOverride ?: "")
        resValue("string", "tpc_base_url", baseUrlOverride)
        resValue("string", "tpc_build_id", buildIdOverride ?: "")
        if (secretOverride != null) resValue("string", "tpc_app_secret", secretOverride)
        if (appNameOverride != null) resValue("string", "app_name", appNameOverride)

        buildConfigField("String", "API_BASE", "\"$baseUrlOverride\"")
        buildConfigField("String", "APP_ID", "\"${appIdOverride ?: ""}\"")
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = releaseKeystoreFile
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
                // keystore nahi mila to bhi build fail na ho
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
        freeCompilerArgs = freeCompilerArgs + listOf("-opt-in=kotlin.RequiresOptIn")
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
    // AppCompat chahiye to rakh do, warna hata do
    implementation("androidx.appcompat:appcompat:1.7.0")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.0.21")
}