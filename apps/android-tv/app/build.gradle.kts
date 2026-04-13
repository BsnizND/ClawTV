plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun escapeBuildConfig(value: String): String {
    return value.replace("\\", "\\\\").replace("\"", "\\\"")
}

val defaultReceiverUrl = "http://10.0.2.2:8787/ClawTV/"
val configuredReceiverUrl = providers.gradleProperty("clawtvReceiverUrl").orNull ?: defaultReceiverUrl

android {
    namespace = "tv.clawtv.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "tv.clawtv.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "CLAWTV_RECEIVER_URL", "\"${escapeBuildConfig(configuredReceiverUrl)}\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
}
