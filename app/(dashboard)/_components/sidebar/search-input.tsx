 "use client";

 import qs from "query-string"
 import { Search } from "lucide-react";
import { useDebounce } from "@uidotdev/usehooks";
import { useRouter } from "next/navigation";
import {
    useEffect,
    useState,
    ChangeEvent
} from "react";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/hooks/use-translation";


 export const SearchInput = () => {
    const { t } = useTranslation();
    const router = useRouter();
    const [value, setValue] = useState("");
    const debouncedValue = useDebounce(value, 500);
    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        setValue(e.target.value);
    };
    useEffect(() => {
        const url = qs.stringifyUrl({
            url: '/',
            query: {
                search: debouncedValue,
            },
        }, { skipEmptyString: true, skipNull: true });
        router.push(url);
    })
    return (
        <div className="w-full relative">
            <Search
               className="absolute top-1/2 left-3 transform -translate-y-1/2 text-muted-foreground h-4 w-4"
               size={20}
            />
            <Input
                className="w-full max-w-[510px] pl-10"
                placeholder={t("navbar.searchPlaceholder")}
                onChange={handleChange}
                value={value}
            />
        </div>
     );
 }