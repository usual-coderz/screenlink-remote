import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---- builder.properties: APK builder isko per-app likhta hai ----
val builderProps = Properties().apply {
    val f = rootProject.file("builder.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// ---- keystore.properties: builder per-app keystore deta hai ----
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

val appIdOverride: String? = builderProps.getProperty("appId")
val versionCodeOverride: Int = (builderProps.getProperty("versionCode") ?: "6").toIntOrNull() ?: 6
val versionNameOverride: String = builderProps.getProperty("versionName") ?: "4.4"

android {
    // namespace kabhi nahi badalta (R class + manifest actions isi par hain)
    namespace = "com.screenlink.remote"
    compileSdk = 35

    defaultConfig {
        // applicationId builder se aata hai -> ek phone par kai APK coexist kar sakte hain
        applicationId = appIdOverride ?: "com.screenlink.remote"
        minSdk = 23
        targetSdk = 35
        versionCode = versionCodeOverride
        versionName = versionNameOverride

        resourceConfigurations += listOf("en")
        vectorDrawables.useSupportLibrary = false
    }

    signingConfigs {
    create("release") {
        val storePath = keystoreProps.getProperty("storeFile")

        if (!storePath.isNullOrBlank()) {
            storeFile = rootProject.file(storePath)
            storePassword = keystoreProps.getProperty("storePassword")
            keyAlias = keystoreProps.getProperty("keyAlias")
            keyPassword = keystoreProps.getProperty("keyPassword")

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
            getDefaultProguardFile("proguard-android-optimize.txt"),
            "proguard-rules.pro"
        )

        signingConfig = if (
            keystoreProps.getProperty("storeFile").isNullOrBlank()
        ) {
            signingConfigs.getByName("debug")
        } else {
            signingConfigs.getByName("release")
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
        // VERSION_NAME / APPLICATION_ID runtime par dikhane ke liye
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
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.0.21")
}