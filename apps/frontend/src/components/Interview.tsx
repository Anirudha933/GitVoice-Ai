import { BACKEND_URL } from "@/lib/config";
import axios from "axios";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AlertTriangle, Bot, Loader2, PhoneOff, User } from "lucide-react";
import { Button } from "./ui/button";
import { VoiceOrb } from "./VoiceOrb";

type Status = "connecting" | "live" | "ending";

/** Attaches an analyser to a stream and returns a getter for its current 0..1 volume level. */
function createLevelMeter(ctx: AudioContext, stream: MediaStream) {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    return () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            const v = (data[i]! - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        // Boost and clamp so normal speech fills most of the range.
        return Math.min(1, rms * 3.2);
    };
}

export function Interview() {
    const { interviewId } = useParams();
    const navigate = useNavigate();

    const [status, setStatus] = useState<Status>("connecting");
    const [aiLevel, setAiLevel] = useState(0);
    const [userLevel, setUserLevel] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [retryCount, setRetryCount] = useState(0);

    // Resources we need to tear down on exit.
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const userStreamRef = useRef<MediaStream | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const rafRef = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const pc = new RTCPeerConnection();
                pcRef.current = pc;

                const audioCtx = new AudioContext();
                audioCtxRef.current = audioCtx;
                let aiMeter: (() => number) | null = null;
                let userMeter: (() => number) | null = null;

                // Play + meter the AI's audio.
                const audioEl = document.createElement("audio");
                audioEl.autoplay = true;
                pc.ontrack = (e) => {
                    const stream = e.streams[0]!;
                    audioEl.srcObject = stream;
                    aiMeter = createLevelMeter(audioCtx, stream);
                };

                // Capture the user's microphone.
                const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
                
                if (cancelled) {
                    ms.getTracks().forEach((t) => t.stop());
                    return;
                }
                userStreamRef.current = ms;
                userMeter = createLevelMeter(audioCtx, ms);

                // Use browser-native Web Speech API for live transcription of the user's responses.
                const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
                let recognition: any = null;

                if (SpeechRecognition) {
                    recognition = new SpeechRecognition();
                    recognition.continuous = true;
                    recognition.interimResults = false;
                    recognition.lang = "en-US";

                    recognition.onresult = (event: any) => {
                        const latestIndex = event.results.length - 1;
                        const transcript = event.results[latestIndex][0].transcript;
                        if (transcript && event.results[latestIndex].isFinal) {
                            axios.post(`${BACKEND_URL}/api/v1/session/user/response/${interviewId}`, {
                                message: transcript.trim(),
                            });
                        }
                    };

                    recognition.onerror = (event: any) => {
                        console.error("Speech recognition error:", event.error);
                    };

                    recognition.start();

                    // Mock the socketRef object so existing cleanup.close() calls work.
                    socketRef.current = {
                        close: () => {
                            try {
                                recognition.stop();
                            } catch (e) {
                                console.error("Error stopping speech recognition:", e);
                            }
                        }
                    } as any;
                }

                pc.addTrack(ms.getTracks()[0]!);

                // SDP handshake with the backend.
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                const sdpResponse = await fetch(`${BACKEND_URL}/api/v1/session/${interviewId}`, {
                    method: "POST",
                    body: offer.sdp,
                    headers: { "Content-Type": "application/sdp" },
                });
                if (!sdpResponse.ok) {
                    const errorText = await sdpResponse.text();
                    throw new Error(`SDP Handshake failed: ${errorText}`);
                }
                const answer = { type: "answer" as const, sdp: await sdpResponse.text() };
                await pc.setRemoteDescription(answer);

                if (cancelled) return;
                setStatus("live");

                // Single animation loop drives both volume meters.
                const tick = () => {
                    if (aiMeter) setAiLevel(aiMeter());
                    if (userMeter) setUserLevel(userMeter());
                    rafRef.current = requestAnimationFrame(tick);
                };
                rafRef.current = requestAnimationFrame(tick);
            } catch (err: any) {
                console.error("Interview setup failed:", err);

                if (cancelled) return;

                let message = "An error occurred while setting up the interview.";
                if (err.name === "NotReadableError" || err.message?.includes("Could not start audio source")) {
                    message = "Could not access your microphone. It might be in use by another application (like Zoom, Teams, or another browser tab). Please close other apps using the microphone and try again.";
                } else if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
                    message = "Microphone access was denied. Please allow microphone permission in your browser settings and try again.";
                } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
                    message = "No microphone was found on your system. Please connect a microphone and try again.";
                } else if (err.message && (err.message.toLowerCase().includes("quota") || err.message.includes("429") || err.message.toLowerCase().includes("exceeded") || err.message.toLowerCase().includes("limit"))) {
                    message = "The OpenAI API key has exceeded its quota or rate limit. Please check your OpenAI billing status/limits, or configure a valid API key in your backend .env file.";
                } else if (err.message) {
                    message = err.message;
                }
                console.log("Error message---",err.message);
                setError(message);
            }
        })();

        return () => {
            cancelled = true;
            cleanup();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [interviewId, retryCount]);

    function cleanup() {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        recorderRef.current?.state !== "inactive" && recorderRef.current?.stop();
        socketRef.current?.close();
        userStreamRef.current?.getTracks().forEach((t) => t.stop());
        pcRef.current?.getSenders().forEach((s) => s.track?.stop());
        pcRef.current?.close();
        audioCtxRef.current?.close().catch(() => {});
    }

    function endInterview() {
        setStatus("ending");
        cleanup();
        navigate(`/result/${interviewId}`);
    }

    const handleRetry = () => {
        setError(null);
        setStatus("connecting");
        setRetryCount((prev) => prev + 1);
    };

    const aiSpeaking = aiLevel > 0.06 && aiLevel >= userLevel;
    const userSpeaking = userLevel > 0.06 && userLevel > aiLevel;

    return (
        <main className="flex h-screen w-screen flex-col overflow-hidden">
            {/* Header */}
            <header className="flex items-center justify-between px-6 py-5">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="relative flex size-2.5">
                        <span
                            className={
                                status === "live"
                                    ? "absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"
                                    : "hidden"
                            }
                        />
                        <span
                            className={
                                "relative inline-flex size-2.5 rounded-full " +
                                (status === "live" ? "bg-emerald-400" : "bg-amber-400")
                            }
                        />
                    </span>
                    {status === "connecting" ? (error ? "Setup failed" : "Connecting…") : status === "ending" ? "Wrapping up…" : "Interview live"}
                </div>
                <span className="text-sm text-muted-foreground">AI Interview</span>
            </header>

            {/* Stage */}
            <div className="flex flex-1 items-center justify-center px-6">
                {error ? (
                    <div className="flex flex-col items-center gap-6 text-center max-w-md p-8 rounded-2xl bg-destructive/5 border border-destructive/10 backdrop-blur-md shadow-lg">
                        <div className="rounded-full bg-destructive/10 p-4">
                            <AlertTriangle className="size-8 text-destructive animate-pulse" />
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-xl font-bold tracking-tight text-foreground">Microphone Access Failed</h2>
                            <p className="text-sm text-muted-foreground leading-relaxed">
                                {error}
                            </p>
                        </div>
                        <div className="flex w-full gap-3">
                            <Button className="flex-1 rounded-full" onClick={handleRetry}>
                                Try Again
                            </Button>
                            <Button variant="outline" className="flex-1 rounded-full" onClick={() => navigate("/")}>
                                Go Back
                            </Button>
                        </div>
                    </div>
                ) : status === "connecting" ? (
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                        <Loader2 className="size-7 animate-spin text-primary" />
                        <p className="text-sm font-medium">Setting up your interview & microphone…</p>
                    </div>
                ) : (
                    <div className="flex w-full max-w-3xl items-center justify-center gap-12 sm:gap-24">
                        <VoiceOrb
                            level={aiLevel}
                            speaking={aiSpeaking}
                            label="Interviewer"
                            sublabel="Listening"
                            icon={Bot}
                            accent="violet"
                        />
                        <VoiceOrb
                            level={userLevel}
                            speaking={userSpeaking}
                            label="You"
                            sublabel="Mic on"
                            icon={User}
                            accent="emerald"
                        />
                    </div>
                )}
            </div>

            {/* Controls */}
            <footer className="flex justify-center px-6 py-8">
                <Button
                    variant="destructive"
                    size="lg"
                    onClick={endInterview}
                    disabled={status === "ending" || !!error}
                    className="gap-2 rounded-full px-6"
                >
                    {status === "ending" ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <PhoneOff className="size-4" />
                    )}
                    End interview
                </Button>
            </footer>
        </main>
    );
}
