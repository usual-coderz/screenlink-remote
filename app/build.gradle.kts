android {
    namespace = "com.screenlink.remote"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.screenlink.remote"
        minSdk = 24
        targetSdk = 35
        versionCode = 4
        versionName = "4.0"
        resourceConfigurations += listOf("en")
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }

    lint {
        abortOnError = false
    }
}