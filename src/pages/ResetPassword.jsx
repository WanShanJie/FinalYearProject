import { useEffect, useState } from "react";
import { resetPassword } from "../api/auth";
import AuthLayout from "../components/AuthLayout";
import { useNavigate, useSearchParams  } from "react-router-dom";

export default function ResetPassword() {
    const [params] = useSearchParams();
    const nav = useNavigate();
    const [token, setToken] = useState("");
    const [pw, setPw] = useState("");
    const [msg, setMsg] = useState("");

    useEffect(() => {
        const tokenFromUrl = params.get("token");
        if (tokenFromUrl) {
        setToken(tokenFromUrl);
        }
    }, [params]);

    async function handleSubmit(e) {
        e.preventDefault();
        try {
        await resetPassword(token, pw);
        setMsg("Password reset successful!");
        setTimeout(() => nav("/signin"), 1500);
        } catch (err) {
        setMsg(err.message);
        }
    }

    return (
        <AuthLayout title="Reset Password">
        <form onSubmit={handleSubmit}>
            <input
            placeholder="Reset token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            />
            <input
            type="password"
            placeholder="New password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            />
            <button type="submit">Reset Password</button>
        </form>
        {msg && <p>{msg}</p>}
        </AuthLayout>
    );
}
