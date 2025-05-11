import Image from "next/image";

export const Loading = () => {
    return (
        <div className="h-full w-full flex flex-col justify-center items-center">
            <Image
                src="/logo.svg"
                alt="Logo"
                width={100}
                height={100}
                className="animate-pulse duration-75"
            />
            <p className="text-gray-500 mt-4">Loading...</p>
        </div>
    )
};