import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useTranslation } from "@/hooks/use-translation";
import { Pause, Play, Square } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export const SessionTimer = () => {
  const { t } = useTranslation();

  const [seconds, setSeconds] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  // TODO: allow user to set duration
  const [duration, setDuration] = useState<number | null>(null); // null = stopwatch mode 
  const [showControls, setShowControls] = useState(false);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isRunning) return;

    intervalRef.current = setInterval(() => {
      setSeconds((prev) => {
        if (duration !== null && prev + 1 >= duration) {
          clearInterval(intervalRef.current!);
          toast.success(t("timer.timeUp"));
          setIsRunning(false);
          return duration;
        }
        return prev + 1;
      });
    }, 1000);

    return () => clearInterval(intervalRef.current!);
  }, [isRunning, duration, t]);

  const reset = () => {
    setIsRunning(false);
    setSeconds(0);
  };

  const timeLeft = duration !== null ? Math.max(duration - seconds, 0) : seconds;
  const minutes = Math.floor(timeLeft / 60)
    .toString()
    .padStart(2, "0");
  const secs = (timeLeft % 60).toString().padStart(2, "0");

  const handleInteraction = () => {
    setShowControls(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      setShowControls(false);
    }, 2500);
  };

  return (
    <div
      className="h-14 w-[80px] bg-white/80 backdrop-blur-sm shadow-md rounded-md px-2 flex flex-col items-center justify-center relative"
      onMouseEnter={handleInteraction}
      onMouseMove={handleInteraction}
    >
      <div className="text-base font-mono tabular-nums leading-none select-none">
        {minutes}:{secs}
      </div>
      <AnimatePresence>
        {showControls && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2 }}
            className="absolute top-full mt-1 bg-white shadow-md rounded-md p-1 flex gap-1"
          >
            {isRunning ? (
              <Button variant="ghost" size="icon" onClick={() => setIsRunning(false)}>
                <Pause className="w-4 h-4" />
              </Button>
            ) : (
              <Button variant="ghost" size="icon" onClick={() => setIsRunning(true)}>
                <Play className="w-4 h-4" />
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={reset}>
              <Square className="w-4 h-4" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};