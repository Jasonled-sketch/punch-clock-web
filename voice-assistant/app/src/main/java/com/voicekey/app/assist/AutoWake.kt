package com.voicekey.app.assist

import android.app.Activity
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.voicekey.app.data.Store

/**
 * 呼喊喚醒的「自動開關」：連上指定的藍牙（車子）或插上充電就開始聽，斷線／拔掉就停。
 * 這樣不用整天開著耗電，也不用每次上車自己去按。
 */
class AutoWakeReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            BluetoothDevice.ACTION_ACL_CONNECTED -> if (isChosen(ctx, intent)) AutoWake.on(ctx, "連上藍牙「${Store.autoBtName(ctx)}」")
            BluetoothDevice.ACTION_ACL_DISCONNECTED -> if (isChosen(ctx, intent)) AutoWake.off(ctx, "藍牙斷線")
            Intent.ACTION_POWER_CONNECTED -> if (Store.autoCharge(ctx)) AutoWake.on(ctx, "開始充電")
            Intent.ACTION_POWER_DISCONNECTED -> if (Store.autoCharge(ctx)) AutoWake.off(ctx, "拔掉充電")
            AutoWake.ACTION_TEST_ON -> if (AutoWake.debuggable(ctx)) AutoWake.on(ctx, "測試")
            AutoWake.ACTION_TEST_OFF -> if (AutoWake.debuggable(ctx)) AutoWake.off(ctx, "測試")
        }
    }

    private fun isChosen(ctx: Context, intent: Intent): Boolean {
        val want = Store.autoBtAddress(ctx)
        if (want.isBlank()) return false
        val device: BluetoothDevice? =
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
        return device?.address.equals(want, ignoreCase = true)
    }
}

object AutoWake {
    const val ACTION_TEST_ON = "com.voicekey.app.AUTO_WAKE_TEST_ON"
    const val ACTION_TEST_OFF = "com.voicekey.app.AUTO_WAKE_TEST_OFF"

    fun debuggable(ctx: Context) = (ctx.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0

    fun on(ctx: Context, why: String) {
        if (WakeService.running) return
        val missing = WakeService.missing(ctx)
        if (missing.isNotEmpty()) { Store.log(ctx, "自動開始聽（$why）沒成功：$missing"); return }
        Store.log(ctx, "自動開始聽喚醒詞：$why")
        Store.setWakeEnabled(ctx, true)
        Store.setWakeAuto(ctx, true)
        // 系統不准在背景啟動的話，WakeService 會自己改成跳一則「點一下開始聽」的通知
        WakeService.start(ctx).let { if (it.isNotEmpty()) WakeService.askTap(ctx) }
    }

    /** 只關「自動開起來的」；人自己手動開的不動它。 */
    fun off(ctx: Context, why: String) {
        WakeService.cancelAskTap(ctx)
        if (!Store.wakeAuto(ctx)) return
        Store.log(ctx, "自動停止聽喚醒詞：$why")
        Store.setWakeAuto(ctx, false)
        Store.setWakeEnabled(ctx, false)
        WakeService.stop(ctx)
    }
}

/** 通知「點一下開始聽」點下去會開到這裡：這時 App 在前景，系統才准啟動用麥克風的常駐服務。 */
class WakeOnActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WakeService.cancelAskTap(this)
        Store.setWakeEnabled(this, true)
        val problem = WakeService.start(this)
        if (problem.isNotEmpty()) android.widget.Toast.makeText(this, problem, android.widget.Toast.LENGTH_LONG).show()
        // 留一下再關：服務要在我們還在前景的時候啟動完成
        Handler(Looper.getMainLooper()).postDelayed({ finish() }, 1500)
    }
}
