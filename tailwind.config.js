/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
        },
        surface: {
          glass: 'rgba(255, 255, 255, 0.08)',
          card: 'rgba(255, 255, 255, 0.12)',
        }
      },
      backdropBlur: {
        xs: '2px',
      },
      animation: {
        'slide-in': 'slideIn 0.3s ease-out',
        'slide-out-left': 'slideOutLeft 0.3s ease-in forwards',
        'slide-out-right': 'slideOutRight 0.3s ease-in forwards',
        'float-up': 'floatUp 0.3s ease-out forwards',
      },
      keyframes: {
        slideIn: {
          '0%': { transform: 'translateX(30px) scale(0.95)', opacity: '0' },
          '100%': { transform: 'translateX(0) scale(1)', opacity: '1' },
        },
        slideOutLeft: {
          '0%': { transform: 'translateX(0)', opacity: '1' },
          '100%': { transform: 'translateX(-100px) rotate(-10deg)', opacity: '0' },
        },
        slideOutRight: {
          '0%': { transform: 'translateX(0)', opacity: '1' },
          '100%': { transform: 'translateX(100px) rotate(10deg)', opacity: '0' },
        },
        floatUp: {
          '0%': { transform: 'translateY(0) scale(1)', opacity: '1' },
          '100%': { transform: 'translateY(-40px) scale(0.8)', opacity: '0' },
        },
      },
    },
  },
  plugins: [],
}
