import { onUnmounted } from "vue";

let lockCount = 0;

function lock(): void {
  lockCount++;
  document.body.style.overflow = "hidden";
}

function unlock(): void {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) document.body.style.overflow = "";
}

export function useScrollLock() {
  let held = false;

  function acquire(): void {
    if (held) return;
    held = true;
    lock();
  }

  function release(): void {
    if (!held) return;
    held = false;
    unlock();
  }

  onUnmounted(() => {
    release();
  });

  return { acquire, release };
}
