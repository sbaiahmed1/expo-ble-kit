package expo.modules.blekit.reference

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * One button, one log. Results also go to Logcat with the tag `BleKitRef`, one `RESULT` line per
 * transfer, for docs/benchmarks.md.
 */
class MainActivity : Activity() {
  private lateinit var output: TextView
  private lateinit var button: Button

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    output = TextView(this).apply { setTextIsSelectable(true) }
    button = Button(this).apply {
      text = "Run benchmarks"
      setOnClickListener { start() }
    }
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(32, 96, 32, 32)
      addView(button)
      addView(output)
    }
    setContentView(ScrollView(this).apply { addView(layout) })
  }

  private val permissions: Array<String>
    get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  private fun start() {
    val missing = permissions.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    if (missing.isNotEmpty()) {
      requestPermissions(missing.toTypedArray(), 1)
      return
    }
    button.isEnabled = false
    output.text = ""
    Thread {
      try {
        Benchmark(this, ::show).runAll()
        show("Done")
      } catch (error: Exception) {
        show("Failed: ${error.message}")
      }
      runOnUiThread { button.isEnabled = true }
    }.start()
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) start()
  }

  private fun show(line: String) {
    Log.i("BleKitRef", line)
    runOnUiThread { output.append("$line\n") }
  }
}
