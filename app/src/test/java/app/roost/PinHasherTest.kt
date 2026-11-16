package app.roost

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PinHasherTest {
    @Test fun correctPinMatchesAndWrongPinDoesNot() {
        val salt = PinHasher.newSalt()
        val hash = PinHasher.hash("4821", salt)
        assertTrue(PinHasher.matches("4821", salt, hash))
        assertFalse(PinHasher.matches("4822", salt, hash))
    }

    @Test fun samePinWithDifferentSaltGivesDifferentHash() {
        assertFalse(PinHasher.hash("0000", PinHasher.newSalt()).contentEquals(PinHasher.hash("0000", PinHasher.newSalt())))
    }

    @Test fun onlyFourDigitsAreValid() {
        assertTrue(PinHasher.isValidPin("0007"))
        listOf("", "123", "12345", "12a4", "١٢٣٤").forEach { assertFalse(it, PinHasher.isValidPin(it)) }
    }
}
