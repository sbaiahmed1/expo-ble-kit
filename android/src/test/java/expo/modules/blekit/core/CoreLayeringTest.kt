package expo.modules.blekit.core

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Plan §4.1 and Appendix B rule 7: the core never imports Expo or React. */
class CoreLayeringTest {
  @Test
  fun `core sources import neither Expo nor React`() {
    // Gradle runs unit tests with the module directory (android/) as the working directory.
    val coreDir = File("src/main/java/expo/modules/blekit/core")
    assertTrue("core sources not found at ${coreDir.absolutePath}", coreDir.isDirectory)

    val forbidden = listOf("import expo.modules.kotlin", "import com.facebook.react")
    val violations =
      coreDir
        .walkTopDown()
        .filter { it.isFile && it.extension == "kt" }
        .flatMap { file ->
          file.readLines().mapIndexedNotNull { index, line ->
            if (forbidden.any { line.trim().startsWith(it) }) "${file.name}:${index + 1}: ${line.trim()}" else null
          }
        }.toList()

    assertTrue("Core must not depend on Expo or React:\n${violations.joinToString("\n")}", violations.isEmpty())
  }
}
