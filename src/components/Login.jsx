import { useState } from "react";
import axios from "axios";
import { saveAuthSession } from "../utils/authSession";

function Login({ onLoginSuccess, onSwitchToSignup }) {
  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
  const loginUrl = `${apiBaseUrl}/api/users/login`;

  const [data, setData] = useState({
    email: "",
    password: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  function handleChange(event) {
    const { name, value } = event.target;
    setData((previous) => ({ ...previous, [name]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);

    if (!data.email.includes("@")) {
      setError("Invalid email");
      setLoading(false);
      return;
    }

    if (data.password.length < 6) {
      setError("Password must be at least 6 characters");
      setLoading(false);
      return;
    }

    try {
      const response = await axios.post(
        loginUrl,
        {
          email: data.email.trim(),
          password: data.password,
        },
        { timeout: 8000 },
      );

      saveAuthSession({
        userId: response.data?.user?._id,
        username: response.data?.user?.username || "",
        token: response.data?.token,
      });

      if (onLoginSuccess) {
        onLoginSuccess();
      }
    } catch (err) {
      const serverMessage = err.response?.data?.message;
      const statusCode = err.response?.status;

      if (serverMessage) {
        setError(`${serverMessage} (status ${statusCode || "unknown"})`);
      } else if (err.code === "ECONNABORTED") {
        setError("Request timed out. Check whether the backend is running.");
      } else if (err.message === "Network Error") {
        setError("Network error. Check backend URL, CORS, and server status.");
      } else if (err.message) {
        setError(`${err.message} (status ${statusCode || "network"})`);
      } else {
        setError("Login failed. Check the backend and network.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-form">
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="email">Email Address</label>
          <input
            id="email"
            type="email"
            name="email"
            placeholder="your@email.com"
            value={data.email}
            onChange={handleChange}
            autoComplete="email"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="password">Password</label>
          <div className="password-field">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              name="password"
              placeholder="********"
              value={data.password}
              onChange={handleChange}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPassword((previous) => !previous)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              title={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {error && <div className="error-message">{error}</div>}

        <button type="submit" disabled={loading} className="submit-btn">
          {loading ? <span className="spinner"></span> : null}
          {loading ? "Logging in..." : "Login"}
        </button>

        <p className="auth-switch">
          {"Don't have an account? "}
          <button type="button" className="auth-switch-btn" onClick={onSwitchToSignup}>
            Sign up
          </button>
        </p>
      </form>
    </div>
  );
}

export default Login;
