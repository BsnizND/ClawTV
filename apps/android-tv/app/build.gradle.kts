plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun escapeBuildConfig(value: String): String {
    return value.replace("\\", "\\\\").replace("\"", "\\\"")
}

val defaultReceiverUrl = "http://192.168.0.71:4390/ClawTV/"
val configuredReceiverUrl = providers.gradleProperty("clawtvReceiverUrl").orNull ?: defaultReceiverUrl
val defaultVoiceAssistantName = providers.gradleProperty("clawtvVoiceAssistantName").orNull ?: "Assistant"
val defaultVoiceAssistantId = providers.gradleProperty("clawtvVoiceAssistantId").orNull ?: "default-assistant"
val defaultVoiceGreetingText = providers.gradleProperty("clawtvVoiceGreetingText").orNull ?: "Hey, what can I do for you?"
val defaultVoiceProcessingText = providers.gradleProperty("clawtvVoiceProcessingText").orNull ?: "Looking into it."
val defaultVoiceAcknowledgementText = providers.gradleProperty("clawtvVoiceAcknowledgementText").orNull ?: "Got it."
val defaultVoiceUnavailableText = providers.gradleProperty("clawtvVoiceUnavailableText").orNull ?: "Voice chat is not available right now."
val defaultVoiceEnabled = providers.gradleProperty("clawtvVoiceEnabled").orNull?.toBooleanStrictOrNull() ?: true

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
        buildConfigField("boolean", "CLAWTV_VOICE_ENABLED", defaultVoiceEnabled.toString())
        buildConfigField("String", "CLAWTV_VOICE_ASSISTANT_NAME", "\"${escapeBuildConfig(defaultVoiceAssistantName)}\"")
        buildConfigField("String", "CLAWTV_VOICE_ASSISTANT_ID", "\"${escapeBuildConfig(defaultVoiceAssistantId)}\"")
        buildConfigField("String", "CLAWTV_VOICE_GREETING_TEXT", "\"${escapeBuildConfig(defaultVoiceGreetingText)}\"")
        buildConfigField("String", "CLAWTV_VOICE_PROCESSING_TEXT", "\"${escapeBuildConfig(defaultVoiceProcessingText)}\"")
        buildConfigField("String", "CLAWTV_VOICE_ACKNOWLEDGEMENT_TEXT", "\"${escapeBuildConfig(defaultVoiceAcknowledgementText)}\"")
        buildConfigField("String", "CLAWTV_VOICE_UNAVAILABLE_TEXT", "\"${escapeBuildConfig(defaultVoiceUnavailableText)}\"")
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
