import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// 簽章金鑰不進版控：放在 voice-assistant/keystore.properties（已列入 .gitignore）
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.voicekey.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.voicekey.app"
        minSdk = 29
        targetSdk = 34
        versionCode = 11
        versionName = "0.9.0"
    }

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("personal") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            // 模擬器（x86_64）＋實機（arm64）
            ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        }
        release {
            // 只留現在手機用的 64 位元版本，安裝檔小很多
            ndk { abiFilters += listOf("arm64-v8a") }
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("personal") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("io.github.biezhi:TinyPinyin:2.0.3.RELEASE")
    // 呼喊喚醒：開源離線語音引擎 Vosk（Apache-2.0），不用帳號金鑰。
    // 中文模型（vosk-model-small-cn-0.22，約 66MB）不進版控：打包前解壓到 app/src/main/assets/vosk-model-small-cn/（見 README）
    implementation("com.alphacephei:vosk-android:0.3.75")
    implementation("net.java.dev.jna:jna:5.18.1@aar")

    testImplementation("junit:junit:4.13.2")
}
