// The swim HUD's score flash (+1,234 SWIM, CLOSE CALL, SPLIT, the show's headlines): it fades in, holds while flashes
// keep coming and fades out after the last one. Flashes used to restart a CSS animation from opacity 0 each time, so a
// run of close calls a few tenths of a second apart (a split is two in one go) blinked the text out and back for each:
// the HUD flickered. Here the element is only switched on and off (`is-on`) and CSS transitions carry the opacity from
// wherever it is, so a new flash while one is up just swaps the text in place with a small scale bump. Timed on the
// game's frame clock, not timers, so it pauses with the game and node tests can step it.

const FLASH_HOLD = 1.3; // s a flash stays up after its last trigger, before it fades out (the CSS sets the fade times)
// The bump a new text gets while the flash is already up: transform only, so the opacity never dips
const BUMP_FRAMES = [{ transform: 'scale(1.07)' }, { transform: 'scale(1)' }];
const BUMP_TIMING = { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' };

class HudFlash {
  constructor(element) {
    this.el = element || null;
    this.timeLeft = 0;
    this.text = '';
    this.kind = '';
  }

  get visible() {
    return this.timeLeft > 0;
  }

  show(text, kind = 'banked') {
    if (!this.el) return;
    const wasUp = this.visible;
    if (kind !== this.kind) {
      this.el.dataset.kind = kind;
      this.kind = kind;
    }
    if (text !== this.text) {
      this.el.textContent = text;
      this.text = text;
      if (wasUp && typeof this.el.animate === 'function') this.el.animate(BUMP_FRAMES, BUMP_TIMING);
    }
    this.timeLeft = FLASH_HOLD;
    if (!wasUp) this.el.classList.add('is-on');
  }

  update(dt) {
    if (!this.visible) return;
    this.timeLeft -= dt;
    if (this.timeLeft > 0) return;
    this.timeLeft = 0;
    this.el.classList.remove('is-on');
  }
}

export { FLASH_HOLD, HudFlash };
