import { useState, useCallback, useEffect } from "react";

interface QuestionModalProps {
  question: string;
  options?: string[];
  onAnswer: (answer: string) => void;
  onClose: () => void;
  timeoutSeconds?: number; // Default 300 (5 min)
}

export function QuestionModal({
  question,
  options,
  onAnswer,
  onClose,
  timeoutSeconds = 300,
}: QuestionModalProps) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [customAnswer, setCustomAnswer] = useState("");
  const [secondsRemaining, setSecondsRemaining] = useState(timeoutSeconds);
  const [showTimeoutWarning, setShowTimeoutWarning] = useState(false);

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          onClose(); // Auto-dismiss on timeout
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [onClose]);

  // Show warning at 1 minute remaining
  useEffect(() => {
    if (secondsRemaining <= 60 && !showTimeoutWarning) {
      setShowTimeoutWarning(true);
    }
  }, [secondsRemaining, showTimeoutWarning]);

  const handleSubmit = useCallback(() => {
    const answer = selectedOption || customAnswer.trim();
    if (answer) {
      onAnswer(answer);
    }
  }, [selectedOption, customAnswer, onAnswer]);

  const isSubmitDisabled = !selectedOption && !customAnswer.trim();

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-bg-elevated rounded-lg w-full max-w-lg mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-bg-elevated">
          <h2 className="text-lg font-semibold text-text-primary">
            Claude is asking
          </h2>
          <div className="flex items-center gap-3">
            {/* Timeout indicator */}
            <span
              className={`text-sm tabular-nums ${showTimeoutWarning ? "text-yellow-400" : "text-text-muted"}`}
            >
              {formatTime(secondsRemaining)}
            </span>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-primary transition-colors"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Timeout warning */}
        {showTimeoutWarning && (
          <div className="px-6 py-2 bg-yellow-900/30 border-b border-yellow-800/50 text-yellow-300 text-sm">
            This question will auto-dismiss in {formatTime(secondsRemaining)}
          </div>
        )}

        {/* Content */}
        <div className="px-6 py-4">
          <p className="text-text-primary mb-4">"{question}"</p>

          {options && options.length > 0 && (
            <div className="space-y-2 mb-4">
              {options.map((option, index) => (
                <label
                  key={index}
                  className={`flex items-center gap-3 p-3 bg-bg-tertiary rounded-md cursor-pointer hover:bg-bg-hover border transition-colors ${
                    selectedOption === option
                      ? "border-accent-primary"
                      : "border-transparent"
                  }`}
                >
                  <input
                    type="radio"
                    name="question-option"
                    value={option}
                    checked={selectedOption === option}
                    onChange={() => {
                      setSelectedOption(option);
                      setCustomAnswer("");
                    }}
                    className="text-accent-primary focus:ring-accent-primary"
                  />
                  <span className="text-text-primary">{option}</span>
                </label>
              ))}
            </div>
          )}

          <div>
            {options && options.length > 0 && (
              <p className="text-text-muted text-sm mb-2">
                Or type a custom response:
              </p>
            )}
            <textarea
              value={customAnswer}
              onChange={(e) => {
                setCustomAnswer(e.target.value);
                setSelectedOption(null);
              }}
              placeholder="Type your response..."
              rows={3}
              className="w-full px-3 py-2 bg-bg-tertiary border border-bg-elevated rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-bg-elevated flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={isSubmitDisabled}
            className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 disabled:bg-bg-tertiary disabled:cursor-not-allowed text-white disabled:text-text-muted rounded-md font-medium transition-colors"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
