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